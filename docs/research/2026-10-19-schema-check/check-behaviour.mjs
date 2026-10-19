import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
db.exec(readFileSync(process.argv[2], 'utf8'));
const results = [];
const expect = (name, fn, wantErr) => {
  try { fn(); results.push([name, wantErr ? `FAIL (no error, wanted ${wantErr})` : 'ok']); }
  catch (e) { const ok = wantErr && String(e.message).includes(wantErr); results.push([name, ok ? `ok (${e.message})` : `FAIL: ${e.message}`]); }
};
db.exec(`INSERT INTO branches(id,slug,name,address,phone) VALUES (1,'hauz-khas','HK','a','+911141550101'),(2,'gurugram','GG','b','+911244550202');
INSERT INTO dining_tables(id,branch_id,label,min_seats,max_seats) VALUES (1,1,'T1',1,2),(2,1,'T5',4,6),(3,2,'T1',1,2);`);
const ins = db.prepare(`INSERT INTO reservations(id,ref,branch_id,table_id,guest_name,phone_e164,party_size,starts_at,ends_at,idempotency_key,request_hash,created_at,status)
  VALUES (?,?,?,?, 'Asha',?,?,?,?,?, 'h', 0, ?)`);
const P1 = '+919876543210', P2 = '+919811111111', P3 = '+919822222222';
const H = 3600_000;
expect('first booking', () => ins.run('r1','NE-AAAAAAA1',1,2,P1,4,10*H,11.5*H,'k1','confirmed'));
expect('table overlap', () => ins.run('r2','NE-AAAAAAA2',1,2,P2,4,11*H,12.5*H,'k2','confirmed'), 'TABLE_OVERLAP');
expect('guest overlap other table', () => ins.run('r3','NE-AAAAAAA3',1,1,P1,2,11*H,12.5*H,'k3','confirmed'), 'GUEST_OVERLAP');
expect('back-to-back allowed', () => ins.run('r4','NE-AAAAAAA4',1,2,P1,4,11.5*H,13*H,'k4','confirmed'));
expect('same key replay -> GUEST_OVERLAP first (SQ-24)', () => ins.run('r5','NE-AAAAAAA5',1,2,P1,4,10*H,11.5*H,'k1','confirmed'), 'GUEST_OVERLAP');
expect('duplicate key non-overlapping -> UNIQUE', () => db.prepare(`INSERT INTO reservations(id,ref,branch_id,table_id,guest_name,phone_e164,party_size,starts_at,ends_at,idempotency_key,request_hash,created_at) VALUES ('r6','NE-AAAAAAA6',1,1,'Bo','+919999999999',2,?,?,'k1','h',0)`).run(50*H, 51*H), 'UNIQUE constraint failed: reservations.idempotency_key');
expect('cross-branch table rejected', () => ins.run('r7','NE-AAAAAAA7',1,3,P1,2,80*H,81*H,'k7','confirmed'), 'FOREIGN KEY constraint failed');
expect('cancel then rebook', () => { db.exec(`UPDATE reservations SET status='cancelled' WHERE id='r1'`); ins.run('r8','NE-AAAAAAA8',1,2,P3,4,10*H,11.5*H,'k8','confirmed'); });
expect('reconfirm cancelled overlapping -> TABLE_OVERLAP (upd trigger)', () => db.exec(`UPDATE reservations SET status='confirmed' WHERE id='r1'`), 'TABLE_OVERLAP');
expect('PK change passes (OLD.id exclusion)', () => db.exec(`UPDATE reservations SET id='r8b' WHERE id='r8'`));
expect('party 9 rejected', () => ins.run('r9','NE-AAAAAAA9',1,2,P1,9,90*H,91*H,'k9','confirmed'), 'CHECK constraint failed');
expect("hours '9:00' rejected", () => db.exec(`INSERT INTO service_hours VALUES (1,1,'lunch','9:00','15:30')`), 'CHECK constraint failed');
expect("hours closes '24:00' ok", () => db.exec(`INSERT INTO service_hours VALUES (1,2,'dinner','19:00','24:00')`));
expect('exception bad date rejected', () => db.exec(`INSERT INTO hours_exceptions(branch_id,date,service,is_closed) VALUES (1,'2026-02-30','lunch',1)`), 'CHECK constraint failed');
expect('exception whole-day open rejected', () => db.exec(`INSERT INTO hours_exceptions(branch_id,date,service,is_closed,opens,closes) VALUES (1,'2026-10-22',NULL,0,'12:00','15:00')`), 'CHECK constraint failed');
expect('exception closed row with NULL times ok', () => db.exec(`INSERT INTO hours_exceptions(branch_id,date,service,is_closed) VALUES (1,'2026-10-22','dinner',1)`));
expect('menu dietary must be JSON', () => db.exec(`INSERT INTO menu_items(slug,category,name,description,price_inr,dietary) VALUES ('x','c','n','d',100,'vegan')`), 'CHECK constraint failed');
expect('fts5 sanitised query', () => { db.exec(`INSERT INTO kb_fts(fact_id, body) VALUES ('faq:pets','Q: Can I bring my dog? A: Well-behaved dogs are welcome on the terrace.')`); const r = db.prepare(`SELECT fact_id FROM kb_fts WHERE kb_fts MATCH ? ORDER BY bm25(kb_fts), fact_id`).all('"bring" OR "dog"'); if (r[0]?.fact_id !== 'faq:pets') throw new Error('no hit'); });
expect('embedding blob length check', () => db.prepare(`INSERT INTO fact_embeddings VALUES ('faq:pets','m','d','h',4,?,0)`).run(new Uint8Array(15)), 'CHECK constraint failed');
for (const [n, r] of results) console.log(`${r.startsWith('ok') ? 'PASS' : 'FAIL'}  ${n}  ${r}`);
console.log(results.every(([, r]) => r.startsWith('ok')) ? 'ALL PASS' : 'SOME FAILED');
