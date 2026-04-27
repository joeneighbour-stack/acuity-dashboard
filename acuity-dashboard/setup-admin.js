const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');
const readline = require('readline');

const db = new Database(path.join(__dirname, 'data', 'app.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'analyst',
    analyst_id TEXT,
    display_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

async function main() {
  console.log('\n=== Acuity Dashboard - User Setup ===\n');

  // Admin
  const existing = db.prepare("SELECT * FROM users WHERE role = 'admin'").get();
  if (existing) {
    console.log(`Admin user already exists: ${existing.username}`);
    const reset = await ask('Reset admin password? (y/n): ');
    if (reset.toLowerCase() === 'y') {
      const pw = await ask('New admin password: ');
      const hash = bcrypt.hashSync(pw, 10);
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, existing.id);
      console.log('✅ Admin password updated');
    }
  } else {
    console.log('Creating admin user...');
    const username = await ask('Admin username (default: admin): ') || 'admin';
    const pw = await ask('Admin password: ');
    const hash = bcrypt.hashSync(pw, 10);
    db.prepare('INSERT INTO users (username, password, role, display_name) VALUES (?, ?, ?, ?)').run(
      username, hash, 'admin', 'Administrator'
    );
    console.log('✅ Admin user created');
  }

  // Analysts
  console.log('\n--- Analyst Accounts ---');
  const analysts = [
    { id: 'IAN', name: 'Ian Coleman', default_user: 'ian' },
    { id: 'KG', name: 'Khaled Gad', default_user: 'khaled' },
    { id: 'MAG', name: 'Maged Darwish', default_user: 'maged' },
    { id: 'MOH', name: 'Mona Hassan', default_user: 'mona' },
    { id: 'TIV', name: 'Tibor Vrbovsky', default_user: 'tibor' }
  ];

  for (const a of analysts) {
    const exists = db.prepare('SELECT * FROM users WHERE analyst_id = ?').get(a.id);
    if (exists) {
      console.log(`  ${a.name} (${a.id}): exists as "${exists.username}"`);
    } else {
      const create = await ask(`  Create account for ${a.name}? (y/n): `);
      if (create.toLowerCase() === 'y') {
        const pw = await ask(`    Password for ${a.name}: `);
        const hash = bcrypt.hashSync(pw, 10);
        db.prepare('INSERT INTO users (username, password, role, analyst_id, display_name) VALUES (?, ?, ?, ?, ?)').run(
          a.default_user, hash, 'analyst', a.id, a.name
        );
        console.log(`    ✅ Created "${a.default_user}"`);
      }
    }
  }

  console.log('\nAll users:');
  db.prepare('SELECT username, role, analyst_id, display_name FROM users').all().forEach(u => {
    console.log(`  ${u.username} | ${u.role} | ${u.analyst_id || '-'} | ${u.display_name}`);
  });

  rl.close();
}

main().catch(console.error);
