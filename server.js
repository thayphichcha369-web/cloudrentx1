'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const multer = require('multer');
// Minimal .env loader (no extra dependency)
try{for(const l of fs.readFileSync(path.join(__dirname,'.env'),'utf8').split(/\r?\n/)){const m=l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);if(m&&!l.trim().startsWith('#')&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^(['"])(.*)\1$/,'$2');}}catch{}
if(!process.env.JWT_SECRET||process.env.JWT_SECRET.startsWith('CHANGE_')){process.env.JWT_SECRET=crypto.randomBytes(32).toString('hex');console.warn('[WARN] JWT_SECRET ไม่ได้ตั้งค่า: ใช้ค่าสุ่มชั่วคราว (ต้องล็อกอินใหม่ทุกครั้งที่รีสตาร์ต)');}
function safeEq(a,b){const x=crypto.createHash('sha256').update(String(a)).digest(),y=crypto.createHash('sha256').update(String(b)).digest();return crypto.timingSafeEqual(x,y);}
const hits=new Map();
function limit(max,winMs){return (req,res,next)=>{const k=req.ip+'|'+req.baseUrl;const t=Date.now();const a=(hits.get(k)||[]).filter(x=>t-x<winMs);if(a.length>=max)return res.status(429).json({error:'ส่งคำขอบ่อยเกินไป กรุณารอสักครู่'});a.push(t);hits.set(k,a);next();};}
setInterval(()=>hits.clear(),600000).unref();

const app = express();
app.disable('x-powered-by');
if(process.env.TRUST_PROXY)app.set('trust proxy',1);
app.use('/api/login',limit(10,60000));
app.use('/api/orders',limit(40,60000));
app.use(express.json({limit:'3mb'}));
const root = __dirname;
const dataDir = path.join(root,'data'); fs.mkdirSync(dataDir,{recursive:true});
fs.mkdirSync(path.join(root,'public','uploads'),{recursive:true});
const db = new Database(path.join(dataDir,'cloudrent.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, name TEXT NOT NULL, cpu TEXT DEFAULT '', gpu TEXT DEFAULT '', ram TEXT DEFAULT '', price REAL NOT NULL DEFAULT 20, protocol TEXT DEFAULT 'Moonlight', remote_url TEXT DEFAULT '', status TEXT DEFAULT 'offline', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, username TEXT NOT NULL, hours INTEGER NOT NULL, protocol TEXT NOT NULL, total REAL NOT NULL, payment_method TEXT NOT NULL, payment_note TEXT DEFAULT '', payment_slip_path TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'awaiting_payment', created_at TEXT NOT NULL, starts_at TEXT, ends_at TEXT, remote_url TEXT DEFAULT '', verification_status TEXT DEFAULT 'not_checked', verification_message TEXT DEFAULT '', transaction_ref TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS commands (id INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL, command TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', created_at TEXT NOT NULL, result TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT DEFAULT '', created_at TEXT NOT NULL);
`);
for (const [col,def] of [['payment_slip_path',"TEXT DEFAULT ''"],['verification_status',"TEXT DEFAULT 'not_checked'"],['verification_message',"TEXT DEFAULT ''"],['transaction_ref',"TEXT DEFAULT ''"]]) { try { db.exec(`ALTER TABLE orders ADD COLUMN ${col} ${def}`); } catch (e) { if (!String(e.message).includes('duplicate column name')) throw e; } }
db.exec(`CREATE TABLE IF NOT EXISTS finance_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL CHECK(type IN ('income','expense')), category TEXT NOT NULL, amount REAL NOT NULL CHECK(amount>0), entry_date TEXT NOT NULL, method TEXT DEFAULT '', note TEXT DEFAULT '', order_id TEXT, source TEXT NOT NULL DEFAULT 'manual', created_by TEXT DEFAULT '', created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_order ON finance_entries(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_date ON finance_entries(entry_date);`);
const bkk=(d=new Date())=>new Date(d.getTime()+7*3600000).toISOString().slice(0,10);
function recordOrderIncome(o){try{db.prepare("INSERT OR IGNORE INTO finance_entries(type,category,amount,entry_date,method,note,order_id,source,created_by,created_at) VALUES('income','ค่าเช่าเครื่อง',?,?,?,?,?,'order','system',?)").run(o.total,bkk(new Date(o.starts_at||Date.now())),o.payment_method,'ค่าเช่า '+o.machine_id+' '+o.hours+' ชม. ('+o.username+')',o.id,new Date().toISOString());}catch(e){console.error('finance',e.message);}}
for(const o of db.prepare("SELECT * FROM orders WHERE status IN ('paid','ended') AND starts_at IS NOT NULL").all())recordOrderIncome(o);
const slipsDir=path.join(dataDir,'payment-slips'); fs.mkdirSync(slipsDir,{recursive:true});
const defaults = {
  site_name:'CloudRent', currency:'THB', promptpay_id:'', bank_name:'', bank_account_name:'', bank_account_number:'', payment_instructions:'โอนเงินแล้วกรอกเลขอ้างอิงให้ผู้ดูแลตรวจสอบ',
  truemoney_number:'', truemoney_instructions:'ส่งเงินผ่าน TrueMoney Wallet แล้วกรอกเลขรายการให้ผู้ดูแลตรวจสอบ',
  payment_qr_path:'', min_hours:'1', max_hours:'24', allow_parsec:'true', allow_moonlight:'true'
};
const insSetting=db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)');
for(const [k,v] of Object.entries(defaults)) insSetting.run(k,v);
if(!db.prepare('SELECT 1 FROM machines LIMIT 1').get()){
 const add=db.prepare('INSERT INTO machines(id,name,cpu,gpu,ram,price,protocol,remote_url,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
 add.run('pc-001','Cloud PC 01','Ryzen 5 5600','RTX 3060','16 GB',20,'Moonlight','','offline',new Date().toISOString());
 add.run('pc-002','Cloud PC 02','Ryzen 7 5700X','RTX 4060','32 GB',30,'Parsec','','offline',new Date().toISOString());
}
const getSettings=()=>Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(x=>[x.key,x.value]));
const setSetting=db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
const now=()=>new Date().toISOString();
function audit(actor,action,detail=''){db.prepare('INSERT INTO audit(actor,action,detail,created_at) VALUES(?,?,?,?)').run(actor,action,String(detail).slice(0,500),now());}
function auth(req,res,next){const h=req.headers.authorization||'';try{const token=h.startsWith('Bearer ')?h.slice(7):'';req.user=jwt.verify(token,process.env.JWT_SECRET||'dev-only-change-me');next();}catch{res.status(401).json({error:'กรุณาเข้าสู่ระบบใหม่'});}}
function admin(req,res,next){auth(req,res,()=>{if(req.user.role!=='admin')return res.status(403).json({error:'เฉพาะผู้ดูแลระบบ'});next();});}
function agentAuth(req,res,next){const expected=process.env.AGENT_TOKEN||'';const got=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');if(!expected||expected.startsWith('CHANGE_')||got.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(got),Buffer.from(expected)))return res.status(401).json({error:'Agent token ไม่ถูกต้อง'});next();}
app.use(express.static(path.join(root,'public')));
app.get('/api/health',(req,res)=>res.json({ok:true,service:'CloudRent',time:now()}));
app.post('/api/login',(req,res)=>{const {username,password}=req.body||{};const u=process.env.ADMIN_USERNAME||'admin', p=process.env.ADMIN_PASSWORD||'CHANGE_THIS_TO_A_LONG_RANDOM_PASSWORD';if(!username||!password||p.startsWith('CHANGE_')||!safeEq(username,u)||!safeEq(password,p))return res.status(401).json({error:'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง หรือยังไม่ได้ตั้งค่า .env'});const token=jwt.sign({sub:u,role:'admin'},process.env.JWT_SECRET||'dev-only-change-me',{expiresIn:'8h'});audit(u,'login','admin login');res.json({token,username:u});});
app.get('/api/public-config',(req,res)=>{const s=getSettings();res.json({site_name:s.site_name,promptpay_id:s.promptpay_id,bank_name:s.bank_name,bank_account_name:s.bank_account_name,bank_account_number:s.bank_account_number,payment_instructions:s.payment_instructions,payment_qr_path:s.payment_qr_path,truemoney_number:s.truemoney_number,truemoney_instructions:s.truemoney_instructions,allow_parsec:s.allow_parsec==='true',allow_moonlight:s.allow_moonlight==='true'});});
app.get('/api/machines',(req,res)=>res.json(db.prepare('SELECT id,name,cpu,gpu,ram,price,protocol,status FROM machines ORDER BY id').all()));
app.get('/api/admin/summary',admin,(req,res)=>res.json({machines:db.prepare('SELECT * FROM machines ORDER BY id').all(),orders:db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200').all(),settings:getSettings(),audit:db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all()}));
app.put('/api/admin/settings',admin,(req,res)=>{const allowed=new Set(Object.keys(defaults));for(const [k,v] of Object.entries(req.body||{})){if(allowed.has(k)&&typeof v!=='object')setSetting.run(k,String(v).slice(0,1000));}audit(req.user.sub,'settings_updated',Object.keys(req.body||{}).join(','));res.json({ok:true,settings:getSettings()});});
const upload=multer({dest:path.join(dataDir,'tmp'),limits:{fileSize:2*1024*1024},fileFilter:(req,file,cb)=>cb(null,['image/png','image/jpeg','image/webp'].includes(file.mimetype))});
app.post('/api/admin/payment-qr',admin,upload.single('qr'),(req,res)=>{if(!req.file)return res.status(400).json({error:'กรุณาเลือกภาพ QR PNG/JPG/WEBP ไม่เกิน 2MB'});const ext=req.file.mimetype==='image/png'?'png':req.file.mimetype==='image/webp'?'webp':'jpg';const dest=path.join(root,'public','uploads','payment-qr.'+ext);for(const e of ['png','jpg','webp']){const f=path.join(root,'public','uploads','payment-qr.'+e);if(fs.existsSync(f))fs.unlinkSync(f);}fs.renameSync(req.file.path,dest);setSetting.run('payment_qr_path','/uploads/payment-qr.'+ext);audit(req.user.sub,'payment_qr_updated',ext);res.json({ok:true,path:'/uploads/payment-qr.'+ext});});
app.post('/api/orders', (req,res)=>{const {machine_id,hours,protocol,payment_method,payment_note,username}=req.body||{};const m=db.prepare('SELECT * FROM machines WHERE id=?').get(machine_id);const h=Number(hours);if(!m||m.status!=='available')return res.status(400).json({error:'เครื่องยังไม่พร้อมให้เช่า'});if(!Number.isInteger(h)||h<1||h>Number(getSettings().max_hours||24))return res.status(400).json({error:'จำนวนชั่วโมงไม่ถูกต้อง'});if(!['promptpay','bank','truemoney'].includes(payment_method))return res.status(400).json({error:'เลือกวิธีชำระเงินไม่ถูกต้อง'});if(protocol==='Parsec'&&getSettings().allow_parsec!=='true'||protocol==='Moonlight'&&getSettings().allow_moonlight!=='true')return res.status(400).json({error:'โปรโตคอลนี้ยังไม่เปิดใช้งาน'});const id='CR-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(2).toString('hex').toUpperCase();const total=Math.round(m.price*h*100)/100;db.prepare('INSERT INTO orders(id,machine_id,username,hours,protocol,total,payment_method,payment_note,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,m.id,String(username||'guest').slice(0,60),h,protocol,total,payment_method,String(payment_note||'').slice(0,300),'awaiting_review',now());audit('customer','order_created',id);res.status(201).json({id,total,status:'awaiting_review',message:'สร้างคำสั่งแล้ว รอผู้ดูแลตรวจสอบการชำระเงิน'});});
const slipUpload=multer({dest:path.join(dataDir,'tmp'),limits:{fileSize:5*1024*1024},fileFilter:(req,file,cb)=>cb(null,['image/png','image/jpeg','image/webp'].includes(file.mimetype))});
async function verifyUploadedSlip(filePath, order) {
  const key = process.env.SLIP_VERIFY_API_KEY || '';
  if (!key || key.startsWith('CHANGE_')) return {status:'manual_review', message:'ยังไม่ได้ตั้งค่า API ตรวจสลิป จึงส่งให้แอดมินตรวจสอบ'};
  const isWallet = order.payment_method === 'truemoney';
  try {
    let response, data;
    if (isWallet) {
      // Thunder documents TrueMoney wallet verification under legacy v1.
      const form = new FormData();
      const bytes = fs.readFileSync(filePath);
      const mime = filePath.endsWith('.png') ? 'image/png' : filePath.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      form.append('file', new Blob([bytes], {type:mime}), path.basename(filePath));
      response = await fetch('https://api.thunder.in.th/v1/verify', {method:'POST',headers:{Authorization:`Bearer ${key}`},body:form,signal:AbortSignal.timeout(15000)});
      data = await response.json().catch(()=>({}));
    } else {
      const form = new FormData();
      const bytes = fs.readFileSync(filePath);
      const mime = filePath.endsWith('.png') ? 'image/png' : filePath.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      form.append('image', new Blob([bytes], {type:mime}), path.basename(filePath));
      form.append('matchAmount', String(Number(order.total)));
      form.append('matchAccount', 'true');
      form.append('checkDuplicate', 'true');
      form.append('remark', order.id);
      response = await fetch('https://api.thunder.in.th/v2/verify/bank', {method:'POST',headers:{Authorization:`Bearer ${key}`},body:form,signal:AbortSignal.timeout(15000)});
      data = await response.json().catch(()=>({}));
    }
    if (!response.ok || data.success !== true) return {status:'manual_review', message:'API ยังยืนยันสลิปไม่ได้: '+String(data?.error?.message || data?.message || `HTTP ${response.status}`).slice(0,180)};
    const d = data.data || data;
    const raw = d.rawSlip || d;
    const amount = Number(d.amountInSlip ?? raw.amount?.amount ?? raw.amount ?? d.amount?.amount ?? NaN);
    const duplicate = d.isDuplicate === true || d.duplicate === true;
    const amountMatch = Number.isFinite(amount) && Math.round(amount*100) === Math.round(Number(order.total)*100);
    const receiver = raw.receiver || d.receiver || {};
    const receiverDigits = String(receiver.account?.bank?.account || receiver.account?.proxy?.account || receiver.accountNumber || receiver.phoneNumber || '').replace(/\D/g,'');
    const expectedWallet = String(getSettings().truemoney_number || '').replace(/\D/g,'');
    const receiverMatched = isWallet ? (!!expectedWallet && !!receiverDigits && (receiverDigits.endsWith(expectedWallet.slice(-8)) || expectedWallet.endsWith(receiverDigits.slice(-8)))) : (d.matchedAccount != null && d.matchedAccount !== false);
    const ref = String(raw.transRef || d.transRef || d.transactionRef || '').slice(0,120);
    if (duplicate) return {status:'rejected', message:'สลิปนี้ถูกใช้แล้ว', ref};
    if (!amountMatch) return {status:'manual_review', message:'ยอดเงินในสลิปไม่ตรงกับยอดคำสั่ง หรือ API ไม่ส่งยอดเงินกลับมา', ref};
    if (!receiverMatched) return {status:'manual_review', message:'ยังจับคู่บัญชีผู้รับไม่ได้ จึงไม่อนุมัติอัตโนมัติ', ref};
    if (!ref) return {status:'manual_review', message:'API ไม่ส่งเลขอ้างอิงธุรกรรมกลับมา จึงต้องให้แอดมินตรวจสอบ', ref};
    return {status:'verified', message:'ตรวจสลิปผ่าน API แล้ว ยอดตรงและไม่พบสลิปซ้ำ', ref};
  } catch (e) {
    return {status:'manual_review', message:'ตรวจสลิปอัตโนมัติไม่สำเร็จ (เครือข่าย/API) กรุณาให้แอดมินตรวจสอบ'};
  }
}
function approveOrderPayment(order) {
  const m = db.prepare('SELECT * FROM machines WHERE id=?').get(order.machine_id);
  if (!m || m.status !== 'available') return false;
  const starts = new Date(), ends = new Date(starts.getTime()+order.hours*3600000);
  db.prepare("UPDATE orders SET status='paid',starts_at=?,ends_at=?,remote_url=? WHERE id=? AND status='awaiting_review'").run(starts.toISOString(),ends.toISOString(),m.remote_url,order.id);
  recordOrderIncome({...order,starts_at:starts.toISOString()});
  db.prepare("UPDATE machines SET status='rented' WHERE id=?").run(m.id);
  return true;
}
app.post('/api/orders/:id/slip',slipUpload.single('slip'),async (req,res)=>{
  const o=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if(!o){if(req.file)fs.unlinkSync(req.file.path);return res.status(404).json({error:'ไม่พบคำสั่งเช่า'});}
  if(o.status!=='awaiting_review'){if(req.file)fs.unlinkSync(req.file.path);return res.status(409).json({error:'คำสั่งนี้ไม่รับสลิปแล้ว'});}
  if(!req.file)return res.status(400).json({error:'กรุณาเลือกภาพสลิป PNG/JPG/WEBP ไม่เกิน 5MB'});
  const ext=req.file.mimetype==='image/png'?'png':req.file.mimetype==='image/webp'?'webp':'jpg';
  const name=o.id.replace(/[^A-Za-z0-9_-]/g,'_')+'-'+crypto.randomBytes(6).toString('hex')+'.'+ext;
  const dest=path.join(slipsDir,name);fs.renameSync(req.file.path,dest);
  const result=await verifyUploadedSlip(dest,o);
  db.prepare('UPDATE orders SET payment_slip_path=?,verification_status=?,verification_message=?,transaction_ref=? WHERE id=?').run(name,result.status,result.message,result.ref||'',o.id);
  audit('customer','payment_slip_uploaded',o.id+':'+result.status);
  if(result.status==='verified') {
    const fresh=db.prepare('SELECT * FROM orders WHERE id=?').get(o.id);
    if(approveOrderPayment(fresh)) { audit('system','payment_auto_approved',o.id); return res.json({ok:true,verification_status:'verified',message:'ตรวจสลิปผ่านอัตโนมัติและอนุมัติการเช่าแล้ว',order_id:o.id}); }
    return res.json({ok:true,verification_status:'verified',message:'สลิปผ่าน แต่เครื่องไม่พร้อมให้เช่า กรุณาติดต่อแอดมิน'});
  }
  if(result.status==='rejected') return res.status(422).json({ok:false,verification_status:result.status,message:result.message+' • เครดิต/สิทธิ์เช่ายังไม่ถูกเพิ่ม'});
  res.json({ok:true,verification_status:result.status,message:result.message+' • ยังไม่อนุมัติการเช่า กรุณารอแอดมินตรวจสอบ'});
});
app.get('/api/admin/orders/:id/slip',admin,(req,res)=>{const o=db.prepare('SELECT payment_slip_path FROM orders WHERE id=?').get(req.params.id);if(!o||!o.payment_slip_path)return res.status(404).json({error:'ยังไม่มีสลิป'});const file=path.join(slipsDir,path.basename(o.payment_slip_path));if(!fs.existsSync(file))return res.status(404).json({error:'ไม่พบไฟล์สลิป'});res.setHeader('Content-Type',o.payment_slip_path.endsWith('.png')?'image/png':o.payment_slip_path.endsWith('.webp')?'image/webp':'image/jpeg');res.setHeader('Cache-Control','no-store');res.sendFile(file);});
app.post('/api/admin/orders/:id/approve',admin,(req,res)=>{const o=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);if(!o)return res.status(404).json({error:'ไม่พบคำสั่ง'});if(o.status!=='awaiting_review')return res.status(409).json({error:'คำสั่งนี้ไม่อยู่ในสถานะรอตรวจสอบ'});const m=db.prepare('SELECT * FROM machines WHERE id=?').get(o.machine_id);if(!m||m.status!=='available')return res.status(409).json({error:'เครื่องไม่พร้อมให้เช่า'});const starts=new Date(), ends=new Date(starts.getTime()+o.hours*3600000);db.prepare("UPDATE orders SET status='paid',starts_at=?,ends_at=?,remote_url=? WHERE id=?").run(starts.toISOString(),ends.toISOString(),m.remote_url,o.id);db.prepare("UPDATE machines SET status='rented' WHERE id=?").run(m.id);recordOrderIncome({...o,starts_at:starts.toISOString()});audit(req.user.sub,'payment_approved',o.id);res.json({ok:true,order:db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)});});
app.post('/api/admin/orders/:id/reject',admin,(req,res)=>{const o=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);if(!o)return res.status(404).json({error:'ไม่พบคำสั่ง'});if(o.status!=='awaiting_review')return res.status(409).json({error:'คำสั่งนี้ไม่อยู่ในสถานะรอตรวจสอบ'});db.prepare("UPDATE orders SET status='rejected' WHERE id=?").run(o.id);audit(req.user.sub,'payment_rejected',o.id);res.json({ok:true});});
app.post('/api/admin/machines',admin,(req,res)=>{const {id,name,cpu='',gpu='',ram='',price=20,protocol='Moonlight',remote_url=''}=req.body||{};if(!id||!name)return res.status(400).json({error:'ต้องระบุ ID และชื่อเครื่อง'});try{db.prepare('INSERT INTO machines(id,name,cpu,gpu,ram,price,protocol,remote_url,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(String(id),String(name),String(cpu),String(gpu),String(ram),Number(price),String(protocol),String(remote_url),'offline',now());audit(req.user.sub,'machine_created',id);res.json({ok:true});}catch{res.status(409).json({error:'ID เครื่องซ้ำหรือข้อมูลไม่ถูกต้อง'});}});
app.put('/api/admin/machines/:id',admin,(req,res)=>{const m=db.prepare('SELECT * FROM machines WHERE id=?').get(req.params.id);if(!m)return res.status(404).json({error:'ไม่พบเครื่อง'});const fields=['name','cpu','gpu','ram','price','protocol','remote_url'];const b=req.body||{};const vals=fields.map(k=>b[k]===undefined?m[k]:b[k]);const pr=Number(vals[4]);if(!Number.isFinite(pr)||pr<=0)return res.status(400).json({error:'ราคาไม่ถูกต้อง'});vals[4]=pr;db.prepare('UPDATE machines SET name=?,cpu=?,gpu=?,ram=?,price=?,protocol=?,remote_url=? WHERE id=?').run(...vals,m.id);if(['available','offline'].includes(b.status)&&m.status!=='rented')db.prepare('UPDATE machines SET status=? WHERE id=?').run(b.status,m.id);audit(req.user.sub,'machine_updated',m.id);res.json({ok:true});});
app.delete('/api/admin/machines/:id',admin,(req,res)=>{const m=db.prepare('SELECT * FROM machines WHERE id=?').get(req.params.id);if(!m)return res.status(404).json({error:'ไม่พบเครื่อง'});if(m.status==='rented'||db.prepare("SELECT 1 FROM orders WHERE machine_id=? AND status IN ('paid','awaiting_review')").get(m.id))return res.status(409).json({error:'ลบไม่ได้: เครื่องมีคำสั่งเช่าที่ยังไม่จบ'});db.prepare('DELETE FROM machines WHERE id=?').run(m.id);audit(req.user.sub,'machine_deleted',m.id);res.json({ok:true});});
app.post('/api/admin/machines/:id/command',admin,(req,res)=>{const {command}=req.body||{};if(!['shutdown','restart','wake'].includes(command))return res.status(400).json({error:'คำสั่งไม่รองรับ'});const m=db.prepare('SELECT * FROM machines WHERE id=?').get(req.params.id);if(!m)return res.status(404).json({error:'ไม่พบเครื่อง'});if(m.status==='rented'&&command!=='wake')return res.status(409).json({error:'เครื่องกำลังถูกเช่า หยุดเซสชันก่อน'});db.prepare('INSERT INTO commands(machine_id,command,created_at) VALUES(?,?,?)').run(m.id,command,now());audit(req.user.sub,'machine_command',m.id+':'+command);res.json({ok:true,message:command==='wake'?'ส่งคำสั่ง Wake แล้ว (เครื่องที่ปิดอยู่ต้องตั้งค่า Wake-on-LAN เพิ่ม)':'ส่งคำสั่งไปยัง Agent แล้ว'});});
app.post('/api/admin/orders/:id/stop',admin,(req,res)=>{const o=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);if(!o)return res.status(404).json({error:'ไม่พบคำสั่ง'});db.prepare("UPDATE orders SET status='ended' WHERE id=?").run(o.id);db.prepare("UPDATE machines SET status='available' WHERE id=?").run(o.machine_id);db.prepare('INSERT INTO commands(machine_id,command,created_at) VALUES(?,?,?)').run(o.machine_id,'end_session',now());audit(req.user.sub,'rental_ended',o.id);res.json({ok:true});});
app.get('/api/agent/commands',agentAuth,(req,res)=>{const id=String(req.query.machine_id||'');if(!id)return res.status(400).json({error:'machine_id required'});const rows=db.prepare("SELECT * FROM commands WHERE machine_id=? AND status='queued' ORDER BY id LIMIT 5").all(id);const upd=db.prepare("UPDATE commands SET status='sent' WHERE id=?");rows.forEach(x=>upd.run(x.id));res.json({commands:rows.map(({id,command})=>({id,command}))});});
app.post('/api/agent/commands/:id/result',agentAuth,(req,res)=>{const {result='',ok=true}=req.body||{};db.prepare('UPDATE commands SET status=?,result=? WHERE id=?').run(ok?'done':'failed',String(result).slice(0,300),Number(req.params.id));res.json({ok:true});});
app.post('/api/agent/heartbeat',agentAuth,(req,res)=>{const {machine_id,status='available'}=req.body||{};const safe=['available','offline','rented','starting'].includes(status)?status:'offline';const m=db.prepare('SELECT id FROM machines WHERE id=?').get(machine_id);if(!m)return res.status(404).json({error:'unknown machine'});db.prepare('UPDATE machines SET status=? WHERE id=? AND status != ?').run(safe,machine_id,'rented');res.json({ok:true,time:now()});});
app.post('/api/orders/:id/note',(req,res)=>{const {payment_note=''}=req.body||{};const o=db.prepare('SELECT id,status FROM orders WHERE id=?').get(req.params.id);if(!o)return res.status(404).json({error:'ไม่พบคำสั่ง'});if(o.status!=='awaiting_review')return res.status(409).json({error:'คำสั่งนี้ไม่อยู่ในสถานะรอตรวจสอบ'});db.prepare('UPDATE orders SET payment_note=? WHERE id=?').run(String(payment_note).slice(0,300),o.id);audit('customer','payment_reference_added',o.id);res.json({ok:true});});
app.get('/api/orders/:id',(req,res)=>{const o=db.prepare('SELECT id,username,hours,protocol,total,payment_method,payment_note,status,created_at,starts_at,ends_at,remote_url FROM orders WHERE id=?').get(req.params.id);if(!o)return res.status(404).json({error:'ไม่พบคำสั่ง'});res.json(o);});

// ===== Finance (admin only) =====
const dateOk=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')&&!isNaN(Date.parse(d));
function finInput(b){b=b||{};const amount=Math.round(Number(b.amount)*100)/100,d=String(b.entry_date||bkk()),cat=String(b.category||'').trim().slice(0,40);
 if(!['income','expense'].includes(b.type))return{error:'ประเภทต้องเป็นรายรับหรือรายจ่าย'};
 if(!Number.isFinite(amount)||amount<=0||amount>100000000)return{error:'จำนวนเงินไม่ถูกต้อง'};
 if(!dateOk(d))return{error:'วันที่ไม่ถูกต้อง (YYYY-MM-DD)'};if(!cat)return{error:'กรุณาระบุหมวดหมู่'};
 return{v:[b.type,cat,amount,d,String(b.method||'').slice(0,40),String(b.note||'').slice(0,300)]};}
function finRange(q){const from=dateOk(q.from)?q.from:'0000-01-01',to=dateOk(q.to)?q.to:'9999-12-31';return[from,to];}
const finSum=(where,args)=>db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount END),0) income, COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) expense FROM finance_entries ${where}`).get(...args);
app.get('/api/admin/finance',admin,(req,res)=>{
 const [from,to]=finRange(req.query),today=bkk(),month=today.slice(0,8)+'01';
 const entries=db.prepare('SELECT * FROM finance_entries WHERE entry_date>=? AND entry_date<=? ORDER BY entry_date DESC,id DESC LIMIT 1000').all(from,to);
 const range=finSum('WHERE entry_date>=? AND entry_date<=?',[from,to]);
 const by_category=db.prepare('SELECT type,category,ROUND(SUM(amount),2) total,COUNT(*) n FROM finance_entries WHERE entry_date>=? AND entry_date<=? GROUP BY type,category ORDER BY type,total DESC').all(from,to);
 const t=finSum('WHERE entry_date=?',[today]),mo=finSum('WHERE entry_date>=?',[month]),all=finSum('',[]);
 const start=bkk(new Date(Date.now()-13*86400000));const rows=db.prepare('SELECT entry_date d,type,SUM(amount) a FROM finance_entries WHERE entry_date>=? GROUP BY entry_date,type').all(start);
 const daily=Array.from({length:14},(_,i)=>{const d=bkk(new Date(Date.now()-(13-i)*86400000));const g=rows.filter(r=>r.d===d);return{date:d,income:g.find(r=>r.type==='income')?.a||0,expense:g.find(r=>r.type==='expense')?.a||0};});
 res.json({entries,range:{...range,net:range.income-range.expense},by_category,stats:{today_income:t.income,month_income:mo.income,month_expense:mo.expense,month_net:mo.income-mo.expense,all_income:all.income,all_expense:all.expense,all_net:all.income-all.expense},daily});});
app.post('/api/admin/finance',admin,(req,res)=>{const r=finInput(req.body);if(r.error)return res.status(400).json({error:r.error});const i=db.prepare("INSERT INTO finance_entries(type,category,amount,entry_date,method,note,source,created_by,created_at) VALUES(?,?,?,?,?,?,'manual',?,?)").run(...r.v,req.user.sub,now());audit(req.user.sub,'finance_added',r.v[0]+':'+r.v[2]+':'+r.v[1]);res.status(201).json({ok:true,id:Number(i.lastInsertRowid)});});
app.put('/api/admin/finance/:id',admin,(req,res)=>{const e=db.prepare('SELECT * FROM finance_entries WHERE id=?').get(Number(req.params.id));if(!e)return res.status(404).json({error:'ไม่พบรายการ'});if(e.source!=='manual')return res.status(409).json({error:'รายการอัตโนมัติจากคำสั่งเช่า แก้ไขไม่ได้'});const r=finInput(req.body);if(r.error)return res.status(400).json({error:r.error});db.prepare('UPDATE finance_entries SET type=?,category=?,amount=?,entry_date=?,method=?,note=? WHERE id=?').run(...r.v,e.id);audit(req.user.sub,'finance_updated',e.id);res.json({ok:true});});
app.delete('/api/admin/finance/:id',admin,(req,res)=>{const e=db.prepare('SELECT * FROM finance_entries WHERE id=?').get(Number(req.params.id));if(!e)return res.status(404).json({error:'ไม่พบรายการ'});if(e.source!=='manual')return res.status(409).json({error:'รายการอัตโนมัติจากคำสั่งเช่า ลบไม่ได้ (ถ้าคืนเงินให้บันทึกเป็นรายจ่ายหมวด "คืนเงิน")'});db.prepare('DELETE FROM finance_entries WHERE id=?').run(e.id);audit(req.user.sub,'finance_deleted',e.id+':'+e.type+':'+e.amount);res.json({ok:true});});
app.get('/api/admin/finance/export',admin,(req,res)=>{const [from,to]=finRange(req.query);const rows=db.prepare('SELECT * FROM finance_entries WHERE entry_date>=? AND entry_date<=? ORDER BY entry_date,id').all(from,to);const c=v=>{let x=String(v??'');if(/^[=+\-@\t\r]/.test(x))x="'"+x;return '"'+x.replace(/"/g,'""')+'"';};const csv='\ufeff'+['วันที่,ประเภท,หมวดหมู่,จำนวนเงิน,ช่องทาง,หมายเหตุ,ที่มา,คำสั่งเช่า',...rows.map(r=>[r.entry_date,r.type==='income'?'รายรับ':'รายจ่าย',r.category,r.amount.toFixed(2),r.method,r.note,r.source==='order'?'อัตโนมัติ':'บันทึกเอง',r.order_id||''].map(c).join(','))].join('\r\n');res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="cloudrent-finance.csv"');res.send(csv);});

// ===== Auto-end expired rentals =====
const expireRentals=db.transaction?db.transaction(()=>{for(const o of db.prepare("SELECT * FROM orders WHERE status='paid' AND ends_at IS NOT NULL AND ends_at<=?").all(now())){db.prepare("UPDATE orders SET status='ended' WHERE id=?").run(o.id);db.prepare("UPDATE machines SET status='available' WHERE id=? AND status='rented'").run(o.machine_id);db.prepare('INSERT INTO commands(machine_id,command,created_at) VALUES(?,?,?)').run(o.machine_id,'end_session',now());audit('system','rental_expired',o.id);}}):()=>{};
setInterval(()=>{try{expireRentals();}catch(e){console.error('expire',e.message);}},30000).unref();try{expireRentals();}catch{}
app.get('*',(req,res)=>res.sendFile(path.join(root,'public','index.html')));
const port=Number(process.env.PORT||3000);app.listen(port,'0.0.0.0',()=>console.log(`CloudRent listening on :${port}`));
