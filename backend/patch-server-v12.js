const fs = require('fs');
let c = fs.readFileSync('src/server.js', 'utf8');

// Adicionar rota perfil-empresa
c = c.replace(
  "app.use('/api/portal-fornecedor', require('./routes/portalFornecedor'));",
  `app.use('/api/portal-fornecedor', require('./routes/portalFornecedor'));
app.use('/api/perfil-empresa',    require('./routes/perfil_empresa'));`
);

// Adicionar migração v12
c = c.replace(
  "    } catch(err) {\n    console.error('❌ Erro ao iniciar servidor:', err);\n    process.exit(1);\n  }\n}\nstart();",
  `    // Migrações automáticas v12 (ERP Adaptativo)
    try {
      const { migrar: migrarV12 } = require('./config/migrate_v12');
      await migrarV12();
    } catch(e) { console.warn('⚠️  migrate_v12 (não bloqueante):', e.message); }
    } catch(err) {
    console.error('❌ Erro ao iniciar servidor:', err);
    process.exit(1);
  }
}
start();`
);

fs.writeFileSync('src/server.js', c);
console.log('OK — server.js actualizado com v12');
