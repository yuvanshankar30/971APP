#!/usr/bin/env python3
"""Run a private few-shot Qwen robot-proposal audit; never creates training data."""
from __future__ import annotations
import argparse, base64, json, os, time
from pathlib import Path
import cv2, requests
from PIL import Image, ImageDraw

def jpeg(frame):
    ok, data=cv2.imencode('.jpg',frame,[cv2.IMWRITE_JPEG_QUALITY,92])
    if not ok: raise RuntimeError('JPEG encoding failed')
    return base64.b64encode(data).decode()

def boxes(row):
    output=[]
    for b in row.get('manual_boxes',[]):
        if b.get('class_name') not in {'red','blue'}: continue
        x,y,w,h=(float(b[k]) for k in ('x','y','w','h'))
        output.append({'alliance':b['class_name'],'box':[round(x*1000),round(y*1000),round((x+w)*1000),round((y+h)*1000)]})
    return output

def boxed_example(encoded, labels):
    """Render human labels into example pixels for models behind vLLM.

    Text coordinates alone are easy for a VLM to detach from the visual object.
    The target is deliberately never modified.
    """
    import io
    image=Image.open(io.BytesIO(base64.b64decode(encoded))).convert('RGB')
    draw=ImageDraw.Draw(image)
    for item in labels:
        x1,y1,x2,y2=(value/1000 for value in item['box'])
        color='#ff4050' if item['alliance']=='red' else '#36a8ff'
        draw.rectangle((x1*image.width,y1*image.height,x2*image.width,y2*image.height),outline=color,width=max(3,image.width//300))
    out=io.BytesIO(); image.save(out,format='JPEG',quality=92)
    return base64.b64encode(out.getvalue()).decode()

def vllm_request(url, token, model, examples, target):
    """Call a loopback vLLM OpenAI-compatible multimodal endpoint."""
    content=[]
    for number, example in enumerate(examples, 1):
        labels=json.dumps(example['boxes'],separators=(',',':'))
        content.extend([
            {'type':'text','text':f'LABELED EXAMPLE {number}. Red outlines are red robots; blue outlines are blue robots. Exact boxes in 0..1000 coordinates: {labels}'},
            {'type':'image_url','image_url':{'url':'data:image/jpeg;base64,'+boxed_example(example['jpeg_base64'],example['boxes'])}},
        ])
    content.extend([
        {'type':'text','text':'TARGET IMAGE: annotate this image only. It has no overlaid boxes.'},
        {'type':'image_url','image_url':{'url':'data:image/jpeg;base64,'+target['jpeg_base64']}},
        {'type':'text','text':'Return exactly JSON, with no markdown: {"boxes":[{"alliance":"red|blue","box":[x1,y1,x2,y2],"confidence":0.0,"evidence":"brief"}]}. Coordinates are integers 0..1000. Only label clearly visible robots. Never label towers, field structures, people, score graphics, balls, reflections, or shadows. Use an empty boxes list if uncertain.'},
    ])
    started=time.perf_counter()
    response=requests.post(url.rstrip('/')+'/v1/chat/completions',headers={'Authorization':'Bearer '+token},json={'model':model,'messages':[{'role':'user','content':content}],'temperature':0,'max_tokens':700},timeout=900)
    response.raise_for_status()
    raw=response.json()['choices'][0]['message']['content']
    from qwen.fewshot_robot_contract import parse, normalize
    parsed,error=parse(raw)
    if error: raise RuntimeError(f'Invalid vLLM response: {error}: {raw[:500]}')
    result,error=normalize(parsed)
    if error: raise RuntimeError(f'Invalid vLLM boxes: {error}: {raw[:500]}')
    return {'boxes':result,'latency_ms':round((time.perf_counter()-started)*1000),'raw_response':raw}

def main():
    p=argparse.ArgumentParser(); p.add_argument('--examples-root',type=Path,required=True); p.add_argument('--examples-review',required=True); p.add_argument('--target-video',type=Path,required=True); p.add_argument('--output',type=Path,required=True); p.add_argument('--url',default='http://127.0.0.1:8000'); p.add_argument('--frames',type=int,default=30); p.add_argument('--token-env',default='VISION_QWEN_TOKEN'); p.add_argument('--vllm-model',help='Use the OpenAI-compatible vLLM endpoint with this served model name.'); a=p.parse_args()
    token=os.environ.get(a.token_env,'')
    if not token: raise SystemExit(f'{a.token_env} is required')
    reviews=json.loads((a.examples_root/a.examples_review).read_text())
    examples=[]
    for image,row in reviews.items():
        labeled=boxes(row)
        path=a.examples_root/image
        if len(labeled)>=2 and path.is_file():
            examples.append({'timestamp_ms':0,'jpeg_base64':base64.b64encode(path.read_bytes()).decode(),'boxes':labeled})
        if len(examples)==4: break
    if len(examples)<4: raise SystemExit('Need four manually labeled example frames')
    root=a.output.resolve(); (root/'images'/'unreviewed').mkdir(parents=True,exist_ok=True); (root/'labels'/'unreviewed').mkdir(parents=True,exist_ok=True)
    cap=cv2.VideoCapture(str(a.target_video)); fps=cap.get(cv2.CAP_PROP_FPS) or 30; every=max(1,round(fps)); rows=[]; index=-1
    while len(rows)<a.frames:
        ok,frame=cap.read()
        if not ok: break
        index+=1
        if index%every: continue
        timestamp=round(index*1000/fps)
        target={'timestamp_ms':timestamp,'jpeg_base64':jpeg(frame)}
        if a.vllm_model:
            result=vllm_request(a.url,token,a.vllm_model,examples,target)
        else:
            response=requests.post(a.url.rstrip('/')+'/annotate-robots',headers={'Authorization':'Bearer '+token},json={'examples':examples,'target':target},timeout=900)
            response.raise_for_status(); result=response.json()
        stem=f'fewshot__{timestamp:09d}ms'
        image=root/'images'/'unreviewed'/f'{stem}.jpg'; label=root/'labels'/'unreviewed'/f'{stem}.txt'; cv2.imwrite(str(image),frame,[cv2.IMWRITE_JPEG_QUALITY,92])
        lines=[]
        for b in result['boxes']:
            x1,y1,x2,y2=[value/1000 for value in b['box']]; cls=0 if b['alliance']=='red' else 1
            lines.append(f'{cls} {(x1+x2)/2:.6f} {(y1+y2)/2:.6f} {x2-x1:.6f} {y2-y1:.6f}')
        label.write_text('\n'.join(lines)+ ('\n' if lines else ''))
        rows.append({'image':str(image.relative_to(root)),'label':str(label.relative_to(root)),'match_key':a.target_video.parent.name,'split':'few-shot-audit','robot_labels':len(lines),'latency_ms':result.get('latency_ms')})
        print(f'{len(rows)}/{a.frames}',flush=True)
    cap.release(); (root/'audit-report.json').write_text(json.dumps({'review_sample':rows},indent=2)+'\n'); print(json.dumps({'frames':len(rows),'purpose':'human audit only; not training data'}))
if __name__=='__main__': main()
