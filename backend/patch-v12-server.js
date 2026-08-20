const fs = require('fs');
let c = fs.readFileSync('src/server.js', 'utf8');

// Verificar se já tem v12
if (c.includes('migrate_v12')) {
  console.log('v12 já existe no server.js');
  process.exit(0);
}

// Adicionar v12 após v11
const v11end = "} catch(e) { console.warn('⚠️  migrate_v11 (não bloqueante):', e.message); }";
const v12block = v11end + `
    // Migrações automáticas v12 (ERP Adaptativo)
    try {
      const { migrar: migrarV12 } = require('./config/migrate_v12');
      await migrarV12();
    } catch(e) { console.warn('⚠️  migrate_v12 (não bloqueante):', e.message); }`;

c = c.replace(v11end, v12block);
fs.writeFileSync('src/server.js', c);
console.log('v12 adicionado:', c.includes('migrate_v12'));
