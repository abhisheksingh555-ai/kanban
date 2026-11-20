const bcrypt = require('bcryptjs');
const db = require('./db');
function seed() {
  if (db.prepare('SELECT 1 FROM users').get()) return;
  const hash = bcrypt.hashSync('password123', 8);
  db.transaction(() => {
    const user = (n, e) => Number(db.prepare('INSERT INTO users(name,email,password_hash) VALUES(?,?,?)').run(n, e, hash).lastInsertRowid);
    const org = (n) => Number(db.prepare('INSERT INTO organizations(name) VALUES(?)').run(n).lastInsertRowid);
    const ten = (o, n) => Number(db.prepare('INSERT INTO tenants(org_id,name) VALUES(?,?)').run(o, n).lastInsertRowid);
    const mem = (u, o, t, r) => db.prepare('INSERT INTO memberships(user_id,org_id,tenant_id,role) VALUES(?,?,?,?)').run(u, o, t, r);
    const [alice, bob, carol, dave, erin] = [user('Alice', 'alice@acme.test'), user('Bob', 'bob@acme.test'), user('Carol', 'carol@acme.test'), user('Dave', 'dave@acme.test'), user('Erin', 'erin@globex.test')];
    const acme = org('Acme Corp'), globex = org('Globex'), nyc = ten(acme, 'New York'), lon = ten(acme, 'London'), hq = ten(globex, 'HQ');
    mem(alice, acme, null, 'org_admin'); mem(bob, acme, nyc, 'tenant_admin'); mem(carol, acme, nyc, 'member'); mem(dave, acme, lon, 'member'); mem(erin, globex, null, 'org_admin');
    for (const [t, name, tasks] of [[nyc, 'NYC Launch', ['Book venue', 'Draft press release', 'Order swag']], [lon, 'London Ops', ['Renew lease', 'Hire analyst']], [hq, 'Roadmap', ['Q1 planning']]]) {
      const b = Number(db.prepare('INSERT INTO boards(tenant_id,name) VALUES(?,?)').run(t, name).lastInsertRowid);
      const cols = ['To do', 'In progress', 'Done'].map((c, i) => Number(db.prepare('INSERT INTO columns(tenant_id,board_id,name,position) VALUES(?,?,?,?)').run(t, b, c, (i + 1) * 1024).lastInsertRowid));
      tasks.forEach((title, i) => db.prepare('INSERT INTO tasks(tenant_id,column_id,title,position) VALUES(?,?,?,?)').run(t, cols[0], title, (i + 1) * 1024));
    }
  })();
  console.log('Seeded. All users use password: password123');
}
module.exports = { seed };
if (require.main === module) seed();
