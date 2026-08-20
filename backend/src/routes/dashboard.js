'use strict';
const router = require('express').Router();
const ctrl   = require('../controllers/dashboardController');
const { autenticar } = require('../middleware/auth');
router.use(autenticar);
router.get('/',                  ctrl.obterKPIs);
router.get('/ferias-calendario', ctrl.calendarioFerias);
router.get('/alertas-horario',   ctrl.alertasHorario);
module.exports = router;
