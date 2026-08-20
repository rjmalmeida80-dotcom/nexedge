'use strict';

// Scheduler simples sem dependências externas
// Corre tarefas automáticas em intervalos definidos

const tarefas = [];

function registar(nome, intervaloMs, fn) {
  console.log(`⏰ Scheduler: a registar "${nome}" (cada ${intervaloMs/1000/60} min)`);
  const id = setInterval(async () => {
    try {
      console.log(`▶️  [${new Date().toLocaleTimeString('pt-PT')}] A executar: ${nome}`);
      await fn();
    } catch (e) {
      console.error(`❌ Erro em "${nome}":`, e.message);
    }
  }, intervaloMs);
  tarefas.push({ nome, id });
}

function parar() {
  tarefas.forEach(t => clearInterval(t.id));
  console.log('⏹️  Scheduler parado.');
}

module.exports = { registar, parar };
