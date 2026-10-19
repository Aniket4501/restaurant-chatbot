import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
db.exec(readFileSync(process.argv[2], 'utf8'));
const out = [];
const expect = (name, fn, wantErr) => {
  try { fn(); out.push([name, wantErr ? `FAIL (no error, wanted ${wantErr})` : 'ok']); }
  catch (e) { out.push([name, wantErr && String(e.message).includes(wantErr) ? `ok (${e.message})` : `FAIL: ${e.message}`]); }
};
db.exec(`INSERT INTO restaurant VALUES (1,'Neem & Ember','Modern Indian','fictional');
INSERT INTO branches(id,slug,name,address,phone) VALUES (1,'hauz-khas','HK','a','+911141550101');
INSERT INTO dining_tables(id,branch_id,label,min_seats,max_seats) VALUES (1,1,'T1',1,2),(2,1,'T5',4,6);`);
const H = 3600_000;
const ins = db.prepare(`INSERT INTO reservations(id,ref,branch_id,table_id,guest_name,phone_e164,party_size,starts_at,ends_at,idempotency_key,request_hash,created_at)
  VALUES (?,?,1,?,?,?,?,?,?,?,'h',0)`);
expect('valid booking', () => ins.run('r1', 'NE-7K3M9Q2X', 2, 'Asha', '+919876543210', 4, 10 * H, 11.5 * H, 'k1'));
expect('NULL id rejected', () => ins.run(null, 'NE-7K3M9Q2Y', 1, 'Asha', '+919876543211', 2, 20 * H, 21 * H, 'k2'), 'NOT NULL constraint failed: reservations.id');
expect('TEXT timestamp rejected (STRICT)', () => ins.run('r3', 'NE-7K3M9Q2Z', 1, 'Asha', '+919876543212', 2, '2026-10-17T14:30:00.000Z', 21 * H, 'k3'), 'cannot store TEXT value in INTEGER column');
expect('spaced phone rejected', () => ins.run('r4', 'NE-7K3M9Q30', 1, 'Asha', '+91 98765 43213', 2, 30 * H, 31 * H, 'k4'), 'CHECK constraint failed');
expect('bad ref alphabet rejected (no I/L/O/U)', () => ins.run('r5', 'NE-7K3M9QIL', 1, 'Asha', '+919876543214', 2, 40 * H, 41 * H, 'k5'), 'CHECK constraint failed');
expect('1-char name rejected', () => ins.run('r6', 'NE-7K3M9Q31', 1, 'A', '+919876543215', 2, 50 * H, 51 * H, 'k6'), 'CHECK constraint failed');
expect('table overlap still raised under STRICT', () => ins.run('r7', 'NE-7K3M9Q32', 2, 'Bina', '+919811111111', 4, 11 * H, 12 * H, 'k7'), 'TABLE_OVERLAP');
expect('second restaurant row rejected', () => db.exec(`INSERT INTO restaurant VALUES (2,'x','y','z')`), 'CHECK constraint failed');
expect('chat_turns bad outcome rejected', () => db.exec(`INSERT INTO chat_turns(id,session_id,intent,outcome,created_at) VALUES ('t1','s','faq','whatever',0)`), 'CHECK constraint failed');
expect('chat_turns valid row', () => db.exec(`INSERT INTO chat_turns(id,session_id,intent,outcome,retrieval_mode,created_at) VALUES ('t2','s','faq','faq_answer','hybrid',0)`));
expect('embedding keyed by digest', () => { const v = new Uint8Array(16); db.prepare(`INSERT INTO fact_embeddings VALUES ('faq:pets','qwen3-embedding:0.6b','ac6da0df',?,4,?,0)`).run('h', v); db.prepare(`INSERT INTO fact_embeddings VALUES ('faq:pets','qwen3-embedding:0.6b','ffff0000',?,4,?,0)`).run('h', v); });
for (const [n, r] of out) console.log(`${r.startsWith('ok') ? 'PASS' : 'FAIL'}  ${n}  ${r}`);
console.log(out.every(([, r]) => r.startsWith('ok')) ? 'ALL PASS' : 'SOME FAILED');
