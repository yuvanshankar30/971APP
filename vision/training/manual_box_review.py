#!/usr/bin/env python3
"""Loopback-only red/blue bounding-box editor for private review frames."""
import argparse,json
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import unquote
HTML='''<!doctype html><style>body{margin:0;background:#101b36;color:white;font:16px system-ui;display:grid;grid-template-columns:1fr 300px;height:100vh}main{display:grid;place-items:center}#s{position:relative;line-height:0}img{display:block;max-width:100%;max-height:95vh}svg{position:absolute;inset:0;width:100%;height:100%;cursor:crosshair}rect{fill:none;stroke-width:.006}aside{padding:16px;background:#172544}button,select,textarea{width:100%;margin:5px 0;padding:8px}textarea{height:120px}</style><main><div id=s><img id=i><svg id=v viewBox="0 0 1 1" preserveAspectRatio="none"></svg></div></main><aside><b id=m></b><select id=c><option value=red>Red robot</option><option value=blue>Blue robot</option></select><button onclick="undo()">Undo last box (Z)</button><button onclick="saveNext()">Save & next (Enter)</button><button onclick="markEmptyNext()">Mark empty & next (0)</button><button onclick="save()">Save boxes + comment</button><textarea id=n placeholder="Comments" oninput="setComments()"></textarea><p>Drag to draw. R/B changes color · Z undo · ←/→ changes frame.</p></aside><script>let a=[],r={},k=0,down,saveTimer;let q=s=>document.querySelector(s);async function go(){a=await(await fetch('/api/sample')).json();r=await(await fetch('/api/reviews')).json();show()}function f(){return a[k]}function completed(){return a.filter(x=>Object.prototype.hasOwnProperty.call(r,x.image)).length}function show(){let x=f(),z=r[x.image]||{};q('#i').src='/frame/'+encodeURIComponent(x.image);q('#m').textContent=(k+1)+' / '+a.length+' · '+completed()+' saved · '+x.match_key;q('#n').value=z.comments||'';draw()}function boxes(){return (r[f().image]||{}).manual_boxes||[]}function draw(){q('#v').innerHTML=boxes().map(b=>`<rect stroke="${b.class_name==='red'?'#ff4d5a':'#55a8ff'}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>`).join('')}function pos(e){let b=q('#v').getBoundingClientRect();return{x:(e.clientX-b.left)/b.width,y:(e.clientY-b.top)/b.height}}q('#v').onpointerdown=e=>down=pos(e);q('#v').onpointerup=e=>{if(!down)return;let p=pos(e),x=Math.min(down.x,p.x),y=Math.min(down.y,p.y),w=Math.abs(p.x-down.x),h=Math.abs(p.y-down.y);if(w>.01&&h>.01){let z=r[f().image]||{};z.manual_boxes=[...(z.manual_boxes||[]),{class_name:q('#c').value,x,y,w,h}];r[f().image]=z;draw();queueSave()}down=null};function undo(){let z=r[f().image]||{};z.manual_boxes=(z.manual_boxes||[]).slice(0,-1);r[f().image]=z;draw();queueSave()}function setComments(){let z=r[f().image]||{};z.comments=q('#n').value;z.image=f().image;z.match_key=f().match_key;r[f().image]=z;queueSave()}function queueSave(){clearTimeout(saveTimer);saveTimer=setTimeout(persist,450)}async function persist(){let z=r[f().image]||{};z.comments=q('#n').value;z.image=f().image;z.match_key=f().match_key;z.reviewed_at=new Date().toISOString();r[f().image]=z;await fetch('/api/reviews',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(r)});show()}async function save(){await persist()}async function saveNext(){await persist();k=Math.min(a.length-1,k+1);show()}async function markEmptyNext(){let z=r[f().image]||{};z.manual_boxes=[];r[f().image]=z;await saveNext()}document.onkeydown=e=>{if(e.target.tagName==='TEXTAREA')return;if(e.key==='r'||e.key==='R')q('#c').value='red';if(e.key==='b'||e.key==='B')q('#c').value='blue';if(e.key==='z'||e.key==='Z')undo();if(e.key==='Enter'){e.preventDefault();saveNext()}if(e.key==='0'){e.preventDefault();markEmptyNext()}if(e.key==='ArrowLeft'){k=Math.max(0,k-1);show()}if(e.key==='ArrowRight'){k=Math.min(a.length-1,k+1);show()}};go()</script>'''
# SVG defaults to preserving its own square aspect ratio. The video is
# widescreen, so opt out or pointer coordinates and drawn boxes diverge.
HTML = HTML.replace('img{max-width:100%;max-height:95vh}', 'img{display:block;max-width:100%;max-height:95vh}')
HTML = HTML.replace('<svg id=v viewBox="0 0 1 1">', '<svg id=v viewBox="0 0 1 1" preserveAspectRatio="none">')

def main():
 p=argparse.ArgumentParser();p.add_argument('dataset',type=Path);p.add_argument('--port',type=int,default=8766);p.add_argument('--sample',type=Path,help='JSON frame manifest, relative to the dataset unless absolute');p.add_argument('--output',type=Path,help='Review JSON, relative to the dataset unless absolute');a=p.parse_args();root=a.dataset.resolve();report=json.loads((root/'audit-report.json').read_text());sample_path=a.sample if a.sample and a.sample.is_absolute() else root/(a.sample or 'audit-report.json');out=a.output if a.output and a.output.is_absolute() else root/(a.output or 'manual-box-reviews.json')
 sample=json.loads(sample_path.read_text());
 if isinstance(sample,dict): sample=sample['review_sample']
 class H(BaseHTTPRequestHandler):
  def send(self,c,b,t='application/json'):self.send_response(c);self.send_header('Content-Type',t);self.end_headers();self.wfile.write(b)
  def do_GET(self):
   if self.path=='/':return self.send(200,HTML.encode(),'text/html')
   if self.path=='/api/sample':return self.send(200,json.dumps(sample).encode())
   if self.path=='/api/reviews':return self.send(200,out.read_bytes() if out.exists() else b'{}')
   if self.path.startswith('/frame/'):
    x=(root/unquote(self.path[7:])).resolve()
    return self.send(200,x.read_bytes(),'image/jpeg') if root in x.parents and x.is_file() else self.send(404,b'no','text/plain')
   self.send(404,b'no','text/plain')
  def do_PUT(self):
   out.write_bytes(self.rfile.read(int(self.headers['Content-Length'])));out.chmod(0o600);self.send(204,b'')
  def log_message(self,*x):pass
 ThreadingHTTPServer(('127.0.0.1',a.port),H).serve_forever()
if __name__=='__main__':main()
