#!/usr/bin/env python3
"""Loopback-only reviewer for a private vision audit sample."""
from __future__ import annotations
import argparse, json
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import unquote
from review_metrics import calculate_review_metrics

PAGE = '''<!doctype html><meta charset="utf-8"><title>Vision frame review</title><style>body{margin:0;background:#101b36;color:#eef3ff;font:16px system-ui;display:grid;grid-template-columns:minmax(0,1fr)380px;height:100vh}main{display:grid;place-items:center;padding:18px}#stage{position:relative;display:inline-block;line-height:0}img{display:block;max-width:100%;max-height:92vh}svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}rect{fill:none;stroke-width:.006}rect.robot_red{stroke:#ff4853}rect.robot_blue{stroke:#55a8ff}text{font:0.035px system-ui;fill:#fff;paint-order:stroke;stroke:#111;stroke-width:.01}aside{padding:20px;background:#172544;overflow:auto}button,select,textarea,input{box-sizing:border-box;font:inherit;padding:8px;margin:5px 0;width:100%}textarea{height:90px}small{color:#b4c0db}.nav{display:flex;gap:8px}.nav button{width:50%}.box-review{border:1px solid #425477;border-radius:6px;padding:8px;margin:8px 0}.box-review label{display:grid;grid-template-columns:1fr 1.6fr;align-items:center}.check{display:flex;gap:8px}.check input{width:auto}#metrics{white-space:pre-wrap;font:12px ui-monospace;color:#b4c0db}</style><main><div id="stage"><img id="image"><svg id="boxes" viewBox="0 0 1 1" preserveAspectRatio="none"></svg></div></main><aside><h2>30-frame independent review</h2><div id="meta"></div><div class="nav"><button onclick="move(-1)">← Previous</button><button onclick="move(1)">Next →</button></div><div id="boxReviews"></div><label>Missed robots<input id="missed" type="number" min="0" value="0"></label><label class="check"><input id="unobservable" type="checkbox">Frame is unobservable</label><label>Comments<textarea id="comments" placeholder="Record ambiguity or evidence."></textarea></label><button onclick="save()">Save review</button><p id="saved"></p><details><summary>Current metrics</summary><pre id="metrics"></pre></details><small>Judge every proposed box independently. Count visible robots with no proposed box as missed. Unobservable frames are excluded from box metrics.</small></aside><script>let sample=[],reviews={},currentBoxes=[],i=0;const q=s=>document.querySelector(s);async function init(){sample=await(await fetch('/api/sample')).json();reviews=await(await fetch('/api/reviews')).json();show()}async function refreshMetrics(){q('#metrics').textContent=JSON.stringify(await(await fetch('/api/metrics')).json(),null,2)}async function show(){let f=sample[i],r=reviews[f.image]||{};q('#image').src='/frame/'+encodeURIComponent(f.image);currentBoxes=await(await fetch('/api/labels/'+encodeURIComponent(f.image))).json();q('#boxes').innerHTML=currentBoxes.map(x=>`<rect class="${x.class_name}" x="${x.x-x.w/2}" y="${x.y-x.h/2}" width="${x.w}" height="${x.h}"/><text x="${x.x-x.w/2}" y="${x.y-x.h/2}">${x.box_index+1}:${x.class_name.replace('robot_','')}</text>`).join('');let prior=new Map((r.boxes||[]).map(x=>[x.box_index,x]));q('#boxReviews').innerHTML=currentBoxes.map(x=>`<div class="box-review"><label>Box ${x.box_index+1} · ${x.class_name.replace('robot_',' ')}<select data-box="${x.box_index}"><option value="unreviewed">Unreviewed</option><option value="correct">Correct</option><option value="wrong_class">Wrong alliance</option><option value="poor_geometry">Poor geometry</option><option value="false_positive">False positive</option></select></label></div>`).join('');currentBoxes.forEach(x=>{q(`[data-box="${x.box_index}"]`).value=prior.get(x.box_index)?.verdict||'unreviewed'});q('#meta').innerHTML='<b>'+(i+1)+' / '+sample.length+'</b><p>'+f.match_key+' · '+f.split+'</p><p>'+f.robot_labels+' proposed robot labels</p>';q('#missed').value=r.missed_robots||0;q('#unobservable').checked=!!r.unobservable;q('#comments').value=r.comments||'';q('#saved').textContent='';refreshMetrics()}function move(n){i=Math.max(0,Math.min(sample.length-1,i+n));show()}async function save(){let f=sample[i],boxes=currentBoxes.map(x=>({box_index:x.box_index,class_name:x.class_name,verdict:q(`[data-box="${x.box_index}"]`).value})),unobservable=q('#unobservable').checked;if(!unobservable&&boxes.some(x=>x.verdict==='unreviewed')){q('#saved').textContent='Review every box or mark the frame unobservable';return}reviews[f.image]={...f,verdict:unobservable?'unobservable':'reviewed',unobservable,boxes,missed_robots:Number(q('#missed').value)||0,comments:q('#comments').value,reviewed_at:new Date().toISOString()};await fetch('/api/reviews',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(reviews)});q('#saved').textContent='Saved';refreshMetrics()}document.addEventListener('keydown',e=>{if(e.target.matches('textarea,select,input'))return;if(e.key==='ArrowLeft'){e.preventDefault();move(-1)}if(e.key==='ArrowRight'){e.preventDefault();move(1)}});init()</script>'''

def main():
 p=argparse.ArgumentParser();p.add_argument('dataset',type=Path);p.add_argument('--port',type=int,default=8765);a=p.parse_args(); root=a.dataset.resolve(); report=json.loads((root/'audit-report.json').read_text()); reviews=root/'independent-review.json'
 class App(BaseHTTPRequestHandler):
  def send(self, code, body, content='application/json'):
   self.send_response(code);self.send_header('Content-Type',content);self.end_headers();self.wfile.write(body)
  def do_GET(self):
   if self.path=='/': return self.send(200,PAGE.encode(),'text/html; charset=utf-8')
   if self.path=='/api/sample': return self.send(200,json.dumps(report['review_sample']).encode())
   if self.path=='/api/reviews': return self.send(200,reviews.read_bytes() if reviews.exists() else b'{}')
   if self.path=='/api/metrics':
    saved=json.loads(reviews.read_text()) if reviews.exists() else {}
    return self.send(200,json.dumps(calculate_review_metrics(report['review_sample'],saved)).encode())
   if self.path.startswith('/api/labels/'):
    image=unquote(self.path[12:]); item=next((row for row in report['review_sample'] if row['image']==image),None)
    if not item: return self.send(404,b'not found','text/plain')
    configured=report.get('class_names') or {str(index): name for index,name in enumerate(report.get('training_classes') or ['robot_red','robot_blue'])}
    class_names={str(key): value for key, value in configured.items()}
    labels=[]
    for line in (root/item['label']).read_text().splitlines():
     class_id,x,y,w,h=line.split(); labels.append({'box_index':len(labels),'class_name':class_names.get(class_id, class_id),'x':float(x),'y':float(y),'w':float(w),'h':float(h)})
    return self.send(200,json.dumps(labels).encode())
   if self.path.startswith('/frame/'):
    target=(root/unquote(self.path[7:])).resolve()
    if root not in target.parents or not target.is_file(): return self.send(404,b'not found','text/plain')
    return self.send(200,target.read_bytes(),'image/jpeg')
   self.send(404,b'not found','text/plain')
  def do_PUT(self):
   if self.path!='/api/reviews': return self.send(404,b'not found','text/plain')
   try: data=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
   except Exception:return self.send(400,b'bad json','text/plain')
   reviews.write_text(json.dumps(data,indent=2)+'\n');reviews.chmod(0o600);self.send(204,b'')
  def log_message(self,*_): pass
 print(f'Private review: ssh -L 127.0.0.1:{a.port}:127.0.0.1:{a.port} spark then open http://127.0.0.1:{a.port}')
 ThreadingHTTPServer(('127.0.0.1',a.port),App).serve_forever()
if __name__=='__main__': main()
