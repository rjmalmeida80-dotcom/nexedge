'use strict';
const router = require('express').Router();
const ctrl   = require('../controllers/authController');
const { autenticar } = require('../middleware/auth');
const { middlewareAuditoria } = require('../middleware/auditoria');

router.post('/login',           ctrl.login);
router.post('/refresh',         ctrl.refresh);
router.post('/logout',          autenticar, ctrl.logout);
router.get('/me',               autenticar, ctrl.me);
router.patch('/alterar-password', autenticar, middlewareAuditoria, ctrl.alterarPassword);
router.post('/recuperar-password', ctrl.pedirResetPassword);
router.post('/reset-password', ctrl.confirmarResetPassword);

module.exports = router;
