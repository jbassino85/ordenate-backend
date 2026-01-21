require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const bcrypt = require('bcrypt');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();

// CORS - Permitir peticiones desde el frontend admin
app.use(cors({
  origin: ['https://ordenate.ai', 'https://www.ordenate.ai', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// ============================================
// SEGURIDAD - CONFIGURACIÓN
// ============================================

// Trust proxy - NECESARIO para Railway/Cloudflare
// Permite que express-rate-limit identifique IPs correctamente
app.set('trust proxy', 1);

// Helmet: Headers de seguridad HTTP
app.use(helmet());

// Rate Limiting para proteger contra DDoS
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 100, // máximo 100 requests por minuto por IP (Twilio puede enviar muchos)
  message: 'Too many requests',
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20, // más restrictivo para otros endpoints
  message: 'Too many requests',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Servir archivos estáticos del admin dashboard
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// ============================================
// CONFIGURACIÓN DE SERVICIOS
// ============================================

// PostgreSQL Connection (Railway)
// LOW SEVERITY FIX: Add timeout configuration to prevent hung connections
// LOW SEVERITY NOTE: rejectUnauthorized: false is used for compatibility with some DB providers
// For better security, consider using proper SSL certificates when available
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? {
    rejectUnauthorized: false
    // TODO: For production security, consider:
    // rejectUnauthorized: true,
    // ca: fs.readFileSync('/path/to/server-certificates/root.crt').toString()
  } : false,
  // Connection timeout settings
  connectionTimeoutMillis: 10000, // 10 seconds to establish connection
  idleTimeoutMillis: 30000,       // 30 seconds before closing idle connection
  max: 20,                         // Maximum number of clients in the pool
  statement_timeout: 30000         // 30 seconds query timeout
});

// Test DB connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Database connection error:', err);
  } else {
    console.log('✅ Database connected:', res.rows[0].now);
  }
});

// Anthropic Claude Client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Twilio Client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ============================================
// WEBHOOK ENDPOINTS
// ============================================

// Root endpoint - NO mostrar información del backend (seguridad)
app.get('/', (req, res) => {
  res.status(404).send('Not Found');
});

// Health check seguro - sin exponer detalles sensibles
app.get('/health', generalLimiter, async (req, res) => {
  try {
    // Verificar DB sin exponer detalles de conexión
    await pool.query('SELECT 1');
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString()
    });
  }
});

// Twilio webhook (recibir mensajes) - CON VALIDACIÓN DE FIRMA
app.post('/webhook', webhookLimiter, async (req, res) => {
  try {
    // ============================================
    // VALIDACIÓN DE FIRMA TWILIO (CRÍTICO)
    // ============================================
    const twilioSignature = req.headers['x-twilio-signature'];
    const url = `https://api.ordenate.ai/webhook`;
    
    // Validar que el request viene realmente de Twilio
    const requestIsValid = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      twilioSignature,
      url,
      req.body
    );
    
    if (!requestIsValid) {
      console.log('⚠️ SECURITY: Invalid Twilio signature - request blocked');
      console.log('   From IP:', req.ip);
      console.log('   Headers:', req.headers);
      return res.status(403).send('Forbidden');
    }
    
    const message = req.body.Body;
    const from = req.body.From.replace('whatsapp:', ''); // Quitar prefijo "whatsapp:"
    
    console.log(`📨 Mensaje recibido de ${from}: ${message}`);
    
    // Procesar mensaje
    await processUserMessage(from, message);
    
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.sendStatus(500);
  }
});

// ============================================
// PROCESAMIENTO DE MENSAJES
// ============================================

// Admin phone (from environment variable for security)
const ADMIN_PHONE = process.env.ADMIN_PHONE || '';

// Feature flags
const SHOW_PREMIUM_MESSAGE = process.env.SHOW_PREMIUM_MESSAGE === 'true';

// Income update prompt configuration
const INCOME_UPDATE_CONFIG = {
  MIN_MONTHS_HISTORY: 2,        // Mínimo meses con ingresos para sugerir
  DIFF_THRESHOLD_PERCENT: 20,   // Diferencia mínima para preguntar (%)
  COOLDOWN_DAYS_NORMAL: 30,     // Días entre preguntas (normal)
  COOLDOWN_DAYS_DECLINED: 60    // Días si usuario dijo "no"
};

async function processUserMessage(phone, message) {
  try {
    console.log(`🔄 Processing message from ${phone}: "${message}"`);
    
    // ADMIN COMMANDS - Solo para el número admin
    if (phone === ADMIN_PHONE && message.startsWith('/admin')) {
      await handleAdminCommand(phone, message);
      return;
    }
    
    // 1. Obtener o crear usuario
    let user = await getOrCreateUser(phone);
    console.log(`👤 User loaded: id=${user.id}, onboarding_complete=${user.onboarding_complete}, onboarding_step="${user.onboarding_step}"`);
    
    // 2. Si no completó onboarding
    if (!user.onboarding_complete) {
      
      // Si está en awaiting_name (inicio), enviar pregunta inicial
      console.log(`🔍 Checking: user.onboarding_step="${user.onboarding_step}" === "awaiting_name" ? ${user.onboarding_step === 'awaiting_name'}`);
      if (user.onboarding_step === 'awaiting_name') {
        await sendWhatsApp(phone,
          '👋 ¡Hola! Soy Ordénate, tu asesor financiero personal.\n\n' +
          'Te voy a ayudar a:\n' +
          '✅ Controlar tus gastos\n' +
          '✅ Alcanzar tus metas de ahorro\n' +
          '✅ Tomar mejores decisiones con tu plata\n\n' +
          'Para empezar...\n\n' +
          '👤 ¿Cómo te llamas?'
        );
        
        // Cambiar step para que próximo mensaje se procese como respuesta
        console.log(`🔄 Updating onboarding_step to awaiting_name_response...`);
        await pool.query(
          'UPDATE users SET onboarding_step = $1 WHERE id = $2',
          ['awaiting_name_response', user.id]
        );
        console.log(`✅ Step updated successfully`);
        return;
      }
      
      // Procesar respuesta de onboarding
      console.log(`🎓 Handling onboarding step: ${user.onboarding_step}`);
      await handleOnboarding(user, message);
      return;
    }
    
    // 3. Verificar si estamos esperando respuesta de income update
    if (user.last_income_update_prompt) {
      const minutesSincePrompt = 
        (Date.now() - new Date(user.last_income_update_prompt)) / (1000 * 60);
      
      // Si preguntamos hace menos de 5 minutos
      if (minutesSincePrompt < 5) {
        const msgLower = message.toLowerCase().trim();
        
        // Detectar aceptación
        if (['si', 'sí', 'dale', 'ok', 'okay', 'actualizar', 'acepto', 'correcto', 'yes'].includes(msgLower)) {
          console.log(`✅ Income update: User accepted (context: ${minutesSincePrompt.toFixed(1)} min ago)`);
          await handleIncomeUpdateResponse(user, { accepted: true });
          return;
        }
        
        // Detectar rechazo
        if (['no', 'nope', 'mejor no', 'después', 'mantener', 'nop', 'nel'].includes(msgLower)) {
          console.log(`❌ Income update: User declined (context: ${minutesSincePrompt.toFixed(1)} min ago)`);
          await handleIncomeUpdateResponse(user, { accepted: false });
          return;
        }
        
        // Si no es sí/no claro, continuar con clasificación normal
        console.log(`⚠️ Income update context active but message ambiguous: "${message}"`);
      }
    }

    // 3.5 Verificar si estamos esperando respuesta de recordatorio mensual (-999)
    if (user.pending_fixed_expense_id === -999) {
      const handled = await handleFixedExpenseReminderResponse(user, message);
      if (handled) return;
      // Si no se procesó, continuar con clasificación normal
    }

    // 3.5.5 Verificar si estamos esperando confirmación de eliminación de cuenta
    if (user.pending_fixed_expense_id === -998) {
      const msgLower = message.toLowerCase().trim();

      if (msgLower === 'confirmar eliminar' || msgLower === 'confirmar' || msgLower === 'si eliminar') {
        // Guardar el teléfono antes de eliminar
        const userPhone = user.phone;

        // Eliminar la cuenta
        await deleteUser(userPhone);

        await sendWhatsApp(userPhone,
          '✅ Tu cuenta ha sido eliminada.\n\n' +
          'Todos tus datos han sido borrados permanentemente.\n\n' +
          '¡Gracias por usar Ordenate! Si cambias de opinión, escríbenos de nuevo para crear una cuenta nueva. 👋'
        );
        return;
      }

      if (msgLower === 'cancelar' || msgLower === 'no') {
        await clearPendingFixedExpense(user.id);
        await sendWhatsApp(user.phone, '👍 Operación cancelada. Tu cuenta sigue activa.');
        return;
      }

      // Si no es confirmación ni cancelación, recordar las opciones
      await sendWhatsApp(user.phone,
        '⚠️ Para eliminar tu cuenta escribe exactamente *"CONFIRMAR ELIMINAR"*\n' +
        'o escribe *"cancelar"* para mantener tu cuenta.'
      );
      return;
    }

    // 3.5.6 Verificar si estamos editando una transacción (< -2000)
    if (user.pending_fixed_expense_id && user.pending_fixed_expense_id < -2000) {
      const msgLower = message.toLowerCase().trim();
      const transactionId = Math.abs(user.pending_fixed_expense_id + 2000);

      // Cancelar edición
      if (msgLower === 'cancelar') {
        await clearPendingFixedExpense(user.id);
        await sendWhatsApp(user.phone, '👍 Ok, edición cancelada.');
        return;
      }

      // Eliminar la transacción
      if (msgLower === 'eliminar' || msgLower === 'borrar') {
        const txResult = await pool.query(
          `SELECT t.amount, t.description, c.emoji as category_emoji, c.name as category_name
           FROM transactions t
           LEFT JOIN categories c ON t.category_id = c.id
           WHERE t.id = $1 AND t.user_id = $2`,
          [transactionId, user.id]
        );

        if (txResult.rows.length > 0) {
          const tx = txResult.rows[0];
          const emoji = tx.category_emoji || '📦';
          const desc = tx.description || tx.category_name || 'Sin descripción';

          await pool.query('DELETE FROM transactions WHERE id = $1 AND user_id = $2', [transactionId, user.id]);
          await clearPendingFixedExpense(user.id);
          await sendWhatsApp(user.phone,
            `🗑️ Eliminado: ${emoji} ${desc} - $${parseFloat(tx.amount).toLocaleString('es-CL')}`
          );
        } else {
          await clearPendingFixedExpense(user.id);
          await sendWhatsApp(user.phone, '❌ No encontré la transacción.');
        }
        return;
      }

      // Cambiar descripción
      if (msgLower.startsWith('desc:') || msgLower.startsWith('descripcion:') || msgLower.startsWith('descripción:')) {
        const newDesc = message.substring(message.indexOf(':') + 1).trim();
        if (newDesc) {
          await pool.query(
            'UPDATE transactions SET description = $1 WHERE id = $2 AND user_id = $3',
            [newDesc, transactionId, user.id]
          );
          await clearPendingFixedExpense(user.id);
          await sendWhatsApp(user.phone, `✅ Descripción actualizada a: "${newDesc}"`);
        } else {
          await sendWhatsApp(user.phone, '🤔 Escribe la nueva descripción después de "desc:"');
        }
        return;
      }

      // Intentar cambiar monto (si es un número)
      const newAmount = extractAmount(message);
      if (newAmount && newAmount > 0) {
        await pool.query(
          'UPDATE transactions SET amount = $1 WHERE id = $2 AND user_id = $3',
          [newAmount, transactionId, user.id]
        );
        await clearPendingFixedExpense(user.id);
        await sendWhatsApp(user.phone, `✅ Monto actualizado a: $${newAmount.toLocaleString('es-CL')}`);
        return;
      }

      // Si no entendimos, mostrar opciones de nuevo
      await sendWhatsApp(user.phone,
        '🤔 No entendí. Opciones:\n' +
        '• Nuevo monto (ej: "50000")\n' +
        '• Nueva descripción (ej: "desc: Almuerzo")\n' +
        '• "eliminar" para borrar\n' +
        '• "cancelar" para salir'
      );
      return;
    }

    // 3.6 Verificar si estamos esperando edición o día de recordatorio para gasto fijo
    if (user.pending_fixed_expense_id && user.pending_fixed_expense_id > 0) {
      const msgLower = message.toLowerCase().trim();

      // Verificar si quiere cancelar
      if (['cancelar', 'saltar', 'skip', 'omitir'].includes(msgLower)) {
        await clearPendingFixedExpense(user.id);
        await sendWhatsApp(user.phone, '👍 Ok, cancelado.');
        return;
      }

      // Verificar si quiere quitar el recordatorio
      if (msgLower.includes('sin recordatorio') || msgLower.includes('quitar recordatorio') ||
          msgLower.includes('sin dia') || msgLower.includes('sin día') || msgLower.includes('quitar dia') ||
          msgLower.includes('quitar día')) {
        await updateFixedExpense(user.pending_fixed_expense_id, user.id, { reminder_day: null });
        await clearPendingFixedExpense(user.id);
        await sendWhatsApp(user.phone, '✅ Recordatorio eliminado. El gasto fijo se mantiene activo.');
        return;
      }

      // Intentar extraer día del mensaje
      const day = extractReminderDay(message);

      // Si el mensaje es SOLO un número entre 1-31, tratarlo como día únicamente
      // (evita confundir "10" como monto cuando solo preguntamos por el día)
      const isJustADay = /^\d{1,2}$/.test(msgLower) && day !== null;

      // Solo extraer monto si NO es solo un día (ej: "500000" o "500000 día 10")
      const amount = isJustADay ? null : extractAmount(message);

      // Si hay monto o día, actualizar el gasto fijo
      if (amount || day) {
        const updates = {};
        if (amount) updates.typical_amount = amount;
        if (day) updates.reminder_day = day;

        await updateFixedExpense(user.pending_fixed_expense_id, user.id, updates);
        await clearPendingFixedExpense(user.id);

        let confirmMsg = '✅ ';
        if (day && !amount) {
          confirmMsg += `Recordatorio configurado para el día ${day} de cada mes.`;
        } else {
          confirmMsg += 'Actualizado:';
          if (amount) confirmMsg += ` monto a $${amount.toLocaleString('es-CL')}`;
          if (amount && day) confirmMsg += ' y';
          if (day) confirmMsg += ` día ${day}`;
        }

        await sendWhatsApp(user.phone, confirmMsg);
        return;
      }

      // Si no detectamos monto ni día, pedir de nuevo
      await sendWhatsApp(user.phone,
        '🤔 No entendí. Escribe:\n' +
        '- Un día del mes (ej: "15")\n' +
        '- O "saltar" si no quieres recordatorio.'
      );
      return;
    }

    // 3.7 Verificar si hay transacción pendiente de marcar como fijo (negativo)
    if (user.pending_fixed_expense_id && user.pending_fixed_expense_id < 0 && user.pending_fixed_expense_id !== -999) {
      const msgLower = message.toLowerCase().trim();
      if (['fijo', 'es fijo', 'si fijo', 'sí fijo', 'hacerlo fijo', 'si', 'sí'].includes(msgLower)) {
        await handleMarkAsFixed(user);
        return;
      }
      // Si no respondió "fijo", crear registro inactivo para recordar el rechazo
      // Así no volveremos a preguntar por este tipo de gasto
      const transactionId = Math.abs(user.pending_fixed_expense_id);
      const txResult = await pool.query(
        `SELECT description, amount, category_id FROM transactions WHERE id = $1`,
        [transactionId]
      );
      if (txResult.rows.length > 0) {
        const tx = txResult.rows[0];
        // Crear fixed_expense inactivo (is_active=false) para recordar que rechazó
        await pool.query(
          `INSERT INTO fixed_expenses (user_id, description, typical_amount, category_id, is_active)
           VALUES ($1, $2, $3, $4, false)
           ON CONFLICT DO NOTHING`,
          [user.id, tx.description, tx.amount, tx.category_id]
        );
      }
      await clearPendingFixedExpense(user.id);
    }

    console.log(`🤖 Classifying intent with Claude...`);
    
    // 4. Usuario completo - clasificar intención con Claude
    const intent = await classifyIntent(message, user);
    
    console.log(`🎯 Intent detected: ${intent.type}`);
    
    // 5. Ejecutar acción según intención
    switch(intent.type) {
      case 'TRANSACTION':
        await handleTransaction(user, intent.data);
        break;
      case 'MULTIPLE_TRANSACTIONS':
        await handleMultipleTransactions(user, intent.data);
        break;
      case 'QUERY':
        await handleQuery(user, intent.data);
        break;
      case 'BUDGET':
        await handleBudget(user, intent.data);
        break;
      case 'BUDGET_STATUS':
        await handleBudgetStatus(user, intent.data);
        break;
      case 'FINANCIAL_ADVICE':
        await handleFinancialAdvice(user, intent.data, message);
        break;
      case 'UPDATE_INCOME_RESPONSE':
        await handleIncomeUpdateResponse(user, intent.data);
        break;
      case 'RECLASSIFY_TRANSACTION':
        await handleReclassifyTransaction(user, intent.data);
        break;
      case 'QUERY_CATEGORIES':
        await handleQueryCategories(user);
        break;
      case 'FIXED_EXPENSES_LIST':
        await handleFixedExpensesList(user);
        break;
      case 'EDIT_FIXED_EXPENSE':
        await handleEditFixedExpense(user, intent.data);
        break;
      case 'DELETE_FIXED_EXPENSE':
        await handleDeleteFixedExpense(user, intent.data);
        break;
      case 'PAUSE_FIXED_EXPENSE':
        await handlePauseFixedExpense(user, intent.data);
        break;
      case 'ACTIVATE_FIXED_EXPENSE':
        await handleActivateFixedExpense(user, intent.data);
        break;
      case 'SET_REMINDER_DAY':
        await handleSetReminderDay(user, intent.data);
        break;
      case 'MARK_AS_FIXED':
        await handleMarkAsFixed(user);
        break;
      case 'LIST_MY_EXPENSES':
        await handleListMyExpenses(user);
        break;
      case 'EDIT_LAST_EXPENSE':
        await handleEditLastExpense(user);
        break;
      case 'DELETE_LAST_EXPENSE':
        await handleDeleteLastExpense(user);
        break;
      case 'EDIT_EXPENSE':
        await handleEditExpense(user, intent.data);
        break;
      case 'DELETE_EXPENSE':
        await handleDeleteExpense(user, intent.data);
        break;
      case 'HELP':
        await handleHelp(user);
        break;
      case 'DELETE_ACCOUNT':
        await handleDeleteAccount(user);
        break;
      default:
        await sendWhatsApp(phone,
          '🤔 Mmm, no te entendí. Prueba con:\n\n' +
          '💸 "Gasté 5000 en almuerzo"\n' +
          '📊 "¿Cuánto gasté esta semana?"\n' +
          '💰 "Máximo 100000 en comida"\n' +
          '📌 "Mis fijos" o "Gasto fijo arriendo 450000"\n' +
          '💡 "¿Cómo ahorro más?"'
        );
    }
  } catch (error) {
    console.error('❌ Process error:', error);
    console.error('❌ Stack:', error.stack);
    await sendWhatsApp(phone, 'Ups, tuve un problema. ¿Puedes intentar de nuevo? 🔧');
  }
}

// ============================================
// CLASIFICACIÓN CON CLAUDE (CON PROMPT CACHING)
// ============================================

async function classifyIntent(message, user) {
  // Cargar categorías válidas desde DB (SIEMPRE consultar DB como fuente de verdad)
  const expenseCategories = await getValidCategories('expense');
  const incomeCategories = await getValidCategories('income');
  
  const expenseCategoriesText = expenseCategories.map(c => c.name).join(', ');
  const incomeCategoriesText = incomeCategories.map(c => c.name).join(', ');
  
  // System instructions (CACHED - Se reutilizan entre llamadas)
  const systemInstructions = [
    {
      type: "text",
      text: `Eres un asistente de finanzas personal en Chile. Analiza mensajes de usuarios y clasifica su intención.

CATEGORÍAS POSIBLES:
1. TRANSACTION: Registrar gasto/ingreso

   GASTOS - Palabras clave: "gasté", "compré", "pagué", "me salió", "me costó"
   Ejemplos: "gasté 5 lucas en almuerzo", "pagué 10000 en uber", "compré en Jumbo"

   GASTOS FIJOS - Palabras clave: "gasto fijo", "fijo", "pago fijo"
   Si el usuario usa estas palabras, marcar is_fixed: true y ask_reminder_day: true
   Ejemplos:
   - "gasto fijo arriendo 450000" → is_fixed: true, ask_reminder_day: true
   - "fijo luz 45000" → is_fixed: true, ask_reminder_day: true
   - "pago fijo spotify 5990" → is_fixed: true, ask_reminder_day: true

   INGRESOS - Palabras clave: "gané", "me pagaron", "cobré", "ingresé", "recibí",
   "me depositaron", "sueldo", "salario", "honorarios", "freelance", "cliente", "pago"
   Ejemplos:
   - "Gané 30000 con un cliente web"
   - "Me pagaron el sueldo 1500000"
   - "Cobré 50000 por el proyecto"
   - "Me depositaron 100000"
   - "Ingresé 50 mil por freelance"

   IMPORTANTE: Si no hay palabra clave clara, asumir que es GASTO (default).
   IMPORTANTE: Para gastos fijos, incluir is_fixed: true y ask_reminder_day: true en data.

   MÚLTIPLES GASTOS EN UNA LÍNEA:
   Si el mensaje contiene "y" o "," separando múltiples gastos, usar tipo MULTIPLE_TRANSACTIONS.
   Ejemplos:
   - "5000 en uber y 15000 en mcdonalds" → MULTIPLE_TRANSACTIONS con 2 transacciones
   - "gasté 3000 en café, 12000 almuerzo y 5000 uber" → MULTIPLE_TRANSACTIONS con 3 transacciones
   - "pagué 50000 arriendo y 20000 luz" → MULTIPLE_TRANSACTIONS con 2 transacciones
   
2. QUERY: Consultar información
   Ejemplos: "¿cuánto gasté esta semana?", "mostrar mis gastos"
   
   Períodos válidos:
   - "today": hoy
   - "yesterday": ayer (palabras clave: "ayer")
   - "week": esta semana
   - "month": este mes
   - "year": este año
   - "last_week": semana pasada
   - "last_month": mes pasado
   
   IMPORTANTE: Cuando el usuario dice "ayer", usar period: "yesterday", NO "today"
   
   Sub-tipos:
   - QUERY_SUMMARY: Resumen agregado por categoría (default)
   - QUERY_DETAIL: Desglose detallado de cada transacción
     Palabras clave: "detalle", "desglose", "cada gasto", "transacciones", "lista completa"
   
   Puede combinar: período + categoría + detalle
   Ejemplos:
   - "detalle de este mes" → period: "month", detail: true
   - "detalle de comida" → category: "comida", detail: true  
   - "detalle de comida de este mes" → period: "month", category: "comida", detail: true
   - "gastos de transporte del mes pasado" → period: "last_month", category: "transporte"
   
3. BUDGET: Configurar presupuesto
   Ejemplos: "quiero gastar máximo 100 lucas en comida", "mi presupuesto de transporte es 50 mil"
   
4. BUDGET_STATUS: Consultar estado de presupuestos
   Ejemplos: "¿cómo van mis presupuestos?", "estado de presupuestos", "resumen de presupuestos"
   
5. FINANCIAL_ADVICE: Consultas de asesoría financiera personalizada
   Ejemplos: "¿puedo comprar un auto?", "¿cómo ahorro más?", "dame consejos financieros", 
             "¿debería gastar en X?", "estrategias de ahorro", "¿puedo permitirme X?"
   
6. UPDATE_INCOME_RESPONSE: Respuesta a sugerencia de actualización de ingreso
   Solo clasificar como este intent si el bot acaba de preguntar sobre actualizar income.
   Ejemplos de ACEPTACIÓN: "sí", "si", "dale", "ok", "actualizar", "acepto", "correcto"
   Ejemplos de RECHAZO: "no", "nope", "mejor no", "después", "mantener"
   Debe retornar: { accepted: true/false }
   
7. RECLASSIFY_TRANSACTION: Reclasificar última transacción a otra categoría
   Palabras clave: "ese gasto debería ir en", "debería ser", "cambiar a", "reclasificar", 
                   "eso era", "clasificar como", "mover a"
   Ejemplos: 
   - "Ese gasto debería ir en comida"
   - "Debería ser transporte"
   - "Cambiar a entretenimiento"
   - "Eso era servicios"
   - "Clasificar como salud"
   Debe retornar: { new_category: "nombre_categoria" }
   
8. QUERY_CATEGORIES: Consultar categorías disponibles
   Palabras clave: "qué categorías", "cuáles categorías", "categorías disponibles",
                   "lista de categorías", "categorías válidas", "en qué puedo clasificar"
   Ejemplos:
   - "¿Qué categorías hay?"
   - "¿Cuáles son las categorías?"
   - "Muéstrame las categorías"
   - "¿En qué categorías puedo clasificar?"
   Debe retornar: {}

9. FIXED_EXPENSES_LIST: Ver lista de gastos fijos
   Palabras clave: "mis fijos", "gastos fijos", "ver fijos", "lista fijos", "mis gastos fijos"
   Ejemplos:
   - "mis fijos"
   - "gastos fijos"
   - "ver fijos"
   - "cuáles son mis gastos fijos"
   Debe retornar: {}

10. EDIT_FIXED_EXPENSE: Editar un gasto fijo
    Palabras clave: "editar fijo", "modificar fijo", "cambiar fijo"
    Ejemplos:
    - "editar fijo 1"
    - "modificar fijo 2"
    - "cambiar el fijo 3"
    Debe retornar: { index: número_del_gasto }

11. DELETE_FIXED_EXPENSE: Eliminar un gasto fijo
    Palabras clave: "eliminar fijo", "borrar fijo", "quitar fijo"
    Ejemplos:
    - "eliminar fijo 1"
    - "borrar fijo 2"
    Debe retornar: { index: número_del_gasto }

12. PAUSE_FIXED_EXPENSE: Pausar un gasto fijo (desactivar recordatorios)
    Palabras clave: "pausar fijo", "desactivar fijo"
    Ejemplos:
    - "pausar fijo 1"
    - "desactivar fijo 2"
    Debe retornar: { index: número_del_gasto }

13. ACTIVATE_FIXED_EXPENSE: Reactivar un gasto fijo pausado
    Palabras clave: "activar fijo", "reactivar fijo"
    Ejemplos:
    - "activar fijo 1"
    - "reactivar fijo 2"
    Debe retornar: { index: número_del_gasto }

14. SET_REMINDER_DAY: Establecer día de recordatorio para gasto fijo
    SOLO usar cuando el usuario responde con un día después de registrar un gasto fijo
    Ejemplos:
    - "5"
    - "día 15"
    - "el 20"
    - "cada 10"
    Debe retornar: { day: número_del_día }

15. MARK_AS_FIXED: Marcar un gasto reciente como fijo
    Palabras clave: "hacer fijo", "hacerlo fijo", "marcar fijo", "último fijo", "ese es fijo"
    Usar cuando el usuario quiere convertir su último gasto en gasto fijo
    También usar si responde "fijo", "es fijo", "sí fijo" después de sugerencia del bot
    Ejemplos:
    - "hacer fijo" → marca el último gasto como fijo
    - "hacerlo fijo"
    - "ese gasto es fijo"
    - "marcar como fijo"
    Debe retornar: {}

16. LIST_MY_EXPENSES: Ver lista de gastos recientes del mes
    Palabras clave: "mis gastos", "ver gastos", "lista de gastos", "gastos del mes", "mostrar gastos"
    Ejemplos:
    - "mis gastos"
    - "ver mis gastos del mes"
    - "lista de gastos"
    - "mostrar gastos"
    Debe retornar: {}

17. EDIT_LAST_EXPENSE: Editar el último gasto registrado
    Palabras clave: "editar último", "cambiar último", "modificar último", "corregir último"
    Ejemplos:
    - "editar último gasto"
    - "cambiar el último gasto"
    - "modificar último"
    - "corregir el monto del último gasto"
    Debe retornar: {}

18. DELETE_LAST_EXPENSE: Eliminar el último gasto registrado
    Palabras clave: "borrar último", "eliminar último", "quitar último"
    Ejemplos:
    - "borrar último gasto"
    - "eliminar el último"
    - "quitar último gasto"
    Debe retornar: {}

19. EDIT_EXPENSE: Editar un gasto específico por número
    Palabras clave: "editar gasto", "modificar gasto", "cambiar gasto" + número
    Ejemplos:
    - "editar gasto 3"
    - "modificar gasto 5"
    - "cambiar el gasto 2"
    Debe retornar: { index: número_del_gasto }

20. DELETE_EXPENSE: Eliminar un gasto específico por número
    Palabras clave: "borrar gasto", "eliminar gasto", "quitar gasto" + número
    Ejemplos:
    - "borrar gasto 3"
    - "eliminar gasto 5"
    - "quitar el gasto 2"
    Debe retornar: { index: número_del_gasto }

21. OTHER: Otro tipo

MODISMOS CHILENOS:
- "lucas/luca/lukas" = miles de pesos (ej: "5 lucas" = 5000)
- "gamba" = 100 pesos
- "palo" = millón
- "chaucha" = poco dinero

CATEGORÍAS DE GASTOS (consultar SIEMPRE esta lista desde la base de datos):
${expenseCategoriesText}

CATEGORÍAS DE INGRESOS (consultar SIEMPRE esta lista desde la base de datos):
${incomeCategoriesText}

IMPORTANTE: SOLO usa las categorías listadas arriba. NO inventes categorías nuevas.
Nota: Cuando is_income = true, usar categorías de ingresos. Cuando is_income = false, usar categorías de gastos.

CONTEXTO TIENDAS CHILENAS (EJEMPLOS):
Estas son tiendas comunes para ayudarte a categorizar, pero NO es una lista exhaustiva. 
Si el usuario menciona una tienda que no está aquí, usa tu criterio inteligente para categorizarla.

SUPERMERCADOS:
Jumbo, Lider, Santa Isabel, Unimarc, Tottus, Acuenta, Ekono, Alvi, Montserrat, Mayor

COMIDA (restaurantes, delivery, cafeterías):
Starbucks, Dunkin, Doggis, Juan Maestro, Telepizza, Papa John's, McDonald's, 
Burger King, KFC, PedidosYa, Uber Eats, Rappi, Cornershop

TRANSPORTE:
Copec, Shell, Petrobras, Terpel, Enex, Transbank (TAG), EasyPay, Metro, 
Uber, Cabify, DiDi, Beat, Turbus, Pullman, Tur Bus

SALUD:
Cruz Verde, Salcobrand, Ahumada, Dr. Simi, Knop, Integramédica, RedSalud, 
Clínica Alemana, UC Christus

COMPRAS (retail, online):
Falabella, Paris, Ripley, La Polar, Hites, Mercado Libre, AliExpress

SERVICIOS (telefonía, internet, utilities):
Entel, Movistar, Claro, WOM, VTR, Mundo Pacifico, CGE, Enel, Chilectra, 
Metrogas, Lipigas, Gasco, Aguas Andinas, ESVAL

ENTRETENIMIENTO (cine, streaming, gym):
Cinemark, Cineplanet, Cinépolis, Hoyts, Netflix, Spotify, Disney+, 
Amazon Prime, Sportlife, Smart Fit, Pacific

HOGAR (mejoramiento, construcción):
Sodimac, Easy, Homecenter, Corona, Construmart

EDUCACIÓN:
Universidad, Instituto, CFT, Colegio, Jardín

IMPORTANTE: Si una tienda no está listada (ej: ChatGPT, OpenAI, Notion), usa tu conocimiento 
general para categorizarla correctamente. Ejemplos: ChatGPT/OpenAI → servicios, 
Notion → servicios, Gym local no listado → entretenimiento.

EJEMPLOS DE CATEGORIZACIÓN DE INGRESOS:
- "Me pagaron el sueldo 1500000" → category: "sueldo", is_income: true
- "Gané 30000 con un cliente web" → category: "freelance", is_income: true
- "Cobré 50000 por el proyecto" → category: "freelance", is_income: true
- "Me depositaron honorarios 100000" → category: "freelance", is_income: true
- "Vendí mi bici en 80000" → category: "ventas", is_income: true
- "Recibí dividendos 20000" → category: "inversiones", is_income: true

REGLAS PARA EL CAMPO "description":
- Capitalizar primera letra del comercio/lugar/fuente
- NO incluir prefijos como "gasto en", "Gasto en", "ingreso de"
- Solo el nombre capitalizado
- Ejemplos correctos:
  GASTOS:
  * Input: "gasté en uber" → Output description: "Uber"
  * Input: "gaste 5000 en mcdonald's" → Output description: "McDonald's"
  * Input: "almuerzo" → Output description: "Almuerzo"
  INGRESOS:
  * Input: "me pagaron el sueldo" → Output description: "Sueldo"
  * Input: "cobré de cliente web" → Output description: "Cliente web"
  * Input: "honorarios proyecto" → Output description: "Proyecto"

FORMATO DE RESPUESTA:
Responde SOLO con JSON válido (sin markdown, sin explicaciones):
{
  "type": "TRANSACTION|MULTIPLE_TRANSACTIONS|QUERY|BUDGET|BUDGET_STATUS|FINANCIAL_ADVICE|FIXED_EXPENSES_LIST|EDIT_FIXED_EXPENSE|DELETE_FIXED_EXPENSE|PAUSE_FIXED_EXPENSE|ACTIVATE_FIXED_EXPENSE|SET_REMINDER_DAY|MARK_AS_FIXED|LIST_MY_EXPENSES|EDIT_LAST_EXPENSE|DELETE_LAST_EXPENSE|EDIT_EXPENSE|DELETE_EXPENSE|HELP|DELETE_ACCOUNT|OTHER",
  "data": {
    "amount": número_sin_símbolos,
    "category": "categoría",
    "description": "texto",
    "is_income": true/false,
    "is_fixed": true/false (true si es gasto fijo),
    "ask_reminder_day": true/false (true si debe preguntar día de recordatorio),
    "period": "today|yesterday|week|month|year|last_week|last_month",
    "detail": true/false (solo para QUERY: true si pide desglose, false para resumen),
    "question": "pregunta_original" (solo para FINANCIAL_ADVICE),
    "index": número (para editar/eliminar/pausar/activar fijo),
    "day": número (para SET_REMINDER_DAY),
    "transactions": [ ... ] (solo para MULTIPLE_TRANSACTIONS - array de objetos con amount, category, description, is_income)
  }
}

EJEMPLOS DE MÚLTIPLES TRANSACCIONES:
- "5000 en uber y 15000 en mcdonalds" → {"type":"MULTIPLE_TRANSACTIONS","data":{"transactions":[{"amount":5000,"category":"transporte","description":"Uber","is_income":false},{"amount":15000,"category":"comida","description":"McDonalds","is_income":false}]}}
- "gasté 3000 café, 12000 almuerzo" → {"type":"MULTIPLE_TRANSACTIONS","data":{"transactions":[{"amount":3000,"category":"comida","description":"Café","is_income":false},{"amount":12000,"category":"comida","description":"Almuerzo","is_income":false}]}}
- "pagué 50000 arriendo y 20000 luz" → {"type":"MULTIPLE_TRANSACTIONS","data":{"transactions":[{"amount":50000,"category":"hogar","description":"Arriendo","is_income":false},{"amount":20000,"category":"servicios","description":"Luz","is_income":false}]}}

EJEMPLOS DE GASTOS FIJOS:
- "gasto fijo arriendo 450000" → {"type":"TRANSACTION","data":{"amount":450000,"category":"hogar","description":"Arriendo","is_income":false,"is_fixed":true,"ask_reminder_day":true}}
- "fijo luz 45000" → {"type":"TRANSACTION","data":{"amount":45000,"category":"servicios","description":"Luz","is_income":false,"is_fixed":true,"ask_reminder_day":true}}
- "mis fijos" → {"type":"FIXED_EXPENSES_LIST","data":{}}
- "editar fijo 1" → {"type":"EDIT_FIXED_EXPENSE","data":{"index":1}}
- "eliminar fijo 2" → {"type":"DELETE_FIXED_EXPENSE","data":{"index":2}}
- "pausar fijo 1" → {"type":"PAUSE_FIXED_EXPENSE","data":{"index":1}}
- "activar fijo 2" → {"type":"ACTIVATE_FIXED_EXPENSE","data":{"index":2}}
- "5" (respuesta a día) → {"type":"SET_REMINDER_DAY","data":{"day":5}}
- "día 15" → {"type":"SET_REMINDER_DAY","data":{"day":15}}
- "fijo" (marcar como fijo) → {"type":"MARK_AS_FIXED","data":{}}

EJEMPLOS DE EDICIÓN DE GASTOS:
- "mis gastos" → {"type":"LIST_MY_EXPENSES","data":{}}
- "ver mis gastos" → {"type":"LIST_MY_EXPENSES","data":{}}
- "lista de gastos" → {"type":"LIST_MY_EXPENSES","data":{}}
- "editar último gasto" → {"type":"EDIT_LAST_EXPENSE","data":{}}
- "cambiar el último" → {"type":"EDIT_LAST_EXPENSE","data":{}}
- "modificar último gasto" → {"type":"EDIT_LAST_EXPENSE","data":{}}
- "borrar último gasto" → {"type":"DELETE_LAST_EXPENSE","data":{}}
- "eliminar el último" → {"type":"DELETE_LAST_EXPENSE","data":{}}
- "editar gasto 3" → {"type":"EDIT_EXPENSE","data":{"index":3}}
- "modificar gasto 5" → {"type":"EDIT_EXPENSE","data":{"index":5}}
- "borrar gasto 2" → {"type":"DELETE_EXPENSE","data":{"index":2}}
- "eliminar gasto 4" → {"type":"DELETE_EXPENSE","data":{"index":4}}

EJEMPLOS DE QUERIES:
- "¿cuánto gasté hoy?" → {"type":"QUERY","data":{"period":"today","detail":false}}
- "¿cuánto gasté ayer?" → {"type":"QUERY","data":{"period":"yesterday","detail":false}}
- "gastos de ayer" → {"type":"QUERY","data":{"period":"yesterday","detail":false}}
- "detalle de ayer" → {"type":"QUERY","data":{"period":"yesterday","detail":true}}
- "detalle de comida de ayer" → {"type":"QUERY","data":{"period":"yesterday","category":"comida","detail":true}}
- "cuanto gaste en transporte ayer" → {"type":"QUERY","data":{"period":"yesterday","category":"transporte","detail":false}}
- "detalle de este mes" → {"type":"QUERY","data":{"period":"month","detail":true}}
- "gastos de comida" → {"type":"QUERY","data":{"category":"comida","detail":false}}
- "detalle de comida de este mes" → {"type":"QUERY","data":{"period":"month","category":"comida","detail":true}}
- "transacciones del mes pasado" → {"type":"QUERY","data":{"period":"last_month","detail":true}}
- "resumen de transporte de la semana pasada" → {"type":"QUERY","data":{"period":"last_week","category":"transporte","detail":false}}
- "¿cómo van mis presupuestos?" → {"type":"BUDGET_STATUS","data":{}}
- "estado de presupuestos" → {"type":"BUDGET_STATUS","data":{}}
- "resumen de presupuestos" → {"type":"BUDGET_STATUS","data":{}}
- "¿puedo comprar un auto?" → {"type":"FINANCIAL_ADVICE","data":{"question":"¿puedo comprar un auto?"}}
- "dame consejos financieros" → {"type":"FINANCIAL_ADVICE","data":{"question":"dame consejos financieros"}}
- "¿cómo ahorro más?" → {"type":"FINANCIAL_ADVICE","data":{"question":"¿cómo ahorro más?"}}
- "¿debería gastar en X?" → {"type":"FINANCIAL_ADVICE","data":{"question":"¿debería gastar en X?"}}

EJEMPLOS DE AYUDA:
- "/ayuda" → {"type":"HELP","data":{}}
- "ayuda" → {"type":"HELP","data":{}}
- "help" → {"type":"HELP","data":{}}
- "como funciona" → {"type":"HELP","data":{}}
- "que puedo hacer" → {"type":"HELP","data":{}}
- "comandos" → {"type":"HELP","data":{}}

EJEMPLOS DE ELIMINAR CUENTA:
- "eliminar mi cuenta" → {"type":"DELETE_ACCOUNT","data":{}}
- "borrar mi cuenta" → {"type":"DELETE_ACCOUNT","data":{}}
- "quiero eliminar mi cuenta" → {"type":"DELETE_ACCOUNT","data":{}}
- "eliminar cuenta" → {"type":"DELETE_ACCOUNT","data":{}}
- "borrar cuenta" → {"type":"DELETE_ACCOUNT","data":{}}
- "delete account" → {"type":"DELETE_ACCOUNT","data":{}}`
    },
    {
      type: "text",
      text: "Analiza el siguiente mensaje del usuario y responde con el JSON de clasificación:",
      cache_control: { type: "ephemeral" }
    }
  ];

  try {
    console.log(`🤖 Calling Claude with prompt caching...`);
    
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: systemInstructions,
      messages: [{
        role: "user",
        content: message
      }]
    });
    
    // Log cache performance
    console.log(`📊 Usage stats:`, JSON.stringify(response.usage));
    
    const usage = response.usage;
    if (usage.cache_creation_input_tokens) {
      console.log(`💾 Cache created: ${usage.cache_creation_input_tokens} tokens`);
    }
    if (usage.cache_read_input_tokens) {
      console.log(`⚡ Cache hit: ${usage.cache_read_input_tokens} tokens (saved ~$${(usage.cache_read_input_tokens * 0.0000009).toFixed(4)})`);
    }

    // MEDIUM SEVERITY FIX: Check if response.content exists before accessing
    if (!response.content || response.content.length === 0) {
      console.error('❌ Empty response from Claude API');
      return { type: 'OTHER' };
    }

    const jsonText = response.content[0].text.trim();
    const cleaned = jsonText.replace(/```json|```/g, '').trim();

    // MEDIUM SEVERITY FIX: Wrap JSON.parse in try-catch to handle invalid JSON
    try {
      return JSON.parse(cleaned);
    } catch (parseError) {
      console.error('❌ JSON parse error:', parseError);
      console.error('   Raw response:', jsonText);
      return { type: 'OTHER' };
    }
  } catch (error) {
    console.error('❌ Claude error:', error);
    return { type: 'OTHER' };
  }
}

// ============================================
// ADMIN COMMANDS
// ============================================

async function handleAdminCommand(phone, message) {
  const parts = message.trim().split(' ');
  const command = parts[1]; // /admin [command]
  const arg = parts[2]; // Argumento opcional
  
  console.log(`🔐 Admin command from ${phone}: ${message}`);
  
  try {
    switch(command) {
      case 'reset':
        if (arg === 'me') {
          // Resetear el usuario admin
          await resetUser(phone);
          await sendWhatsApp(phone, '✅ Tu usuario fue reseteado. Envía "hola" para empezar de nuevo.');
        } else if (arg && arg.startsWith('+')) {
          // Resetear otro usuario
          await resetUser(arg);
          await sendWhatsApp(phone, `✅ Usuario ${arg} fue reseteado.`);
        } else {
          await sendWhatsApp(phone, '❌ Uso: /admin reset me\n o /admin reset +56912345678');
        }
        break;
        
      case 'delete':
        if (arg && arg.startsWith('+')) {
          await deleteUser(arg);
          await sendWhatsApp(phone, `✅ Usuario ${arg} fue eliminado completamente.`);
        } else {
          await sendWhatsApp(phone, '❌ Uso: /admin delete +56912345678');
        }
        break;
        
      case 'users':
        const userCount = await pool.query('SELECT COUNT(*) as total FROM users');
        const total = userCount.rows[0].total;
        await sendWhatsApp(phone, `📊 Total usuarios: ${total}`);
        break;
        
      case 'stats':
        const stats = await getSystemStats();
        await sendWhatsApp(phone, 
          `📊 Estadísticas del Sistema:\n\n` +
          `👥 Usuarios: ${stats.totalUsers}\n` +
          `✅ Onboarding completo: ${stats.completedOnboarding}\n` +
          `💸 Total gastos: $${stats.totalExpenses.toLocaleString('es-CL')}\n` +
          `💰 Total ingresos: $${stats.totalIncome.toLocaleString('es-CL')}\n` +
          `📝 Total transacciones: ${stats.totalTransactions}`
        );
        break;
        
      case 'user':
        if (arg && arg.startsWith('+')) {
          const userInfo = await getUserInfo(arg);
          if (!userInfo) {
            await sendWhatsApp(phone, `❌ Usuario ${arg} no encontrado.`);
          } else {
            await sendWhatsApp(phone,
              `👤 Info Usuario: ${arg}\n\n` +
              `ID: ${userInfo.id}\n` +
              `Onboarding: ${userInfo.onboarding_complete ? '✅ Completo' : '❌ Incompleto'}\n` +
              `Ingreso: $${(userInfo.monthly_income || 0).toLocaleString('es-CL')}\n` +
              `Meta ahorro: $${(userInfo.savings_goal || 0).toLocaleString('es-CL')}\n` +
              `Gastos este mes: $${userInfo.monthlyExpenses.toLocaleString('es-CL')}\n` +
              `Ingresos este mes: $${userInfo.monthlyIncome.toLocaleString('es-CL')}\n` +
              `Total transacciones: ${userInfo.totalTransactions}`
            );
          }
        } else {
          await sendWhatsApp(phone, '❌ Uso: /admin user +56912345678');
        }
        break;
        
      default:
        await sendWhatsApp(phone,
          '🔐 Comandos Admin:\n\n' +
          '/admin reset me → Resetear tu usuario\n' +
          '/admin reset +56... → Resetear otro usuario\n' +
          '/admin delete +56... → Eliminar usuario\n' +
          '/admin users → Total usuarios\n' +
          '/admin stats → Estadísticas sistema\n' +
          '/admin user +56... → Info de usuario'
        );
    }
  } catch (error) {
    console.error('❌ Admin command error:', error);
    await sendWhatsApp(phone, `❌ Error ejecutando comando: ${error.message}`);
  }
}

// Admin helper functions
async function resetUser(phone) {
  const result = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
  if (result.rows.length > 0) {
    const userId = result.rows[0].id;

    // Primero limpiar referencia a fixed_expenses para evitar problemas de FK
    await pool.query('UPDATE users SET pending_fixed_expense_id = NULL WHERE id = $1', [userId]);

    // Eliminar todas las transacciones
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);

    // Eliminar gastos fijos
    await pool.query('DELETE FROM fixed_expenses WHERE user_id = $1', [userId]);

    // Eliminar presupuestos
    await pool.query('DELETE FROM budgets WHERE user_id = $1', [userId]);

    // Eliminar alertas
    await pool.query('DELETE FROM financial_alerts WHERE user_id = $1', [userId]);

    // Resetear campos de onboarding e income update
    await pool.query(
      `UPDATE users
       SET name = NULL,
           monthly_income = NULL,
           savings_goal = NULL,
           onboarding_complete = false,
           onboarding_step = 'awaiting_name',
           last_income_update_prompt = NULL,
           income_update_declined = false
       WHERE id = $1`,
      [userId]
    );
  }
}

async function deleteUser(phone) {
  const result = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
  if (result.rows.length > 0) {
    const userId = result.rows[0].id;

    // Limpiar referencia a fixed_expenses primero
    await pool.query('UPDATE users SET pending_fixed_expense_id = NULL WHERE id = $1', [userId]);

    // Eliminar datos relacionados explícitamente (por seguridad, aunque CASCADE debería funcionar)
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM fixed_expenses WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM budgets WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM financial_alerts WHERE user_id = $1', [userId]);

    // Finalmente eliminar el usuario
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
}

async function getSystemStats() {
  const users = await pool.query('SELECT COUNT(*) as total FROM users');
  const completed = await pool.query('SELECT COUNT(*) as total FROM users WHERE onboarding_complete = true');
  
  const expenses = await pool.query(
    'SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE is_income = false'
  );
  
  const income = await pool.query(
    'SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE is_income = true'
  );
  
  const transactions = await pool.query('SELECT COUNT(*) as total FROM transactions');
  
  return {
    totalUsers: parseInt(users.rows[0].total),
    completedOnboarding: parseInt(completed.rows[0].total),
    totalExpenses: parseFloat(expenses.rows[0].total),
    totalIncome: parseFloat(income.rows[0].total),
    totalTransactions: parseInt(transactions.rows[0].total)
  };
}

async function getUserInfo(phone) {
  const user = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
  if (user.rows.length === 0) return null;
  
  const userData = user.rows[0];
  
  const monthlyExpenses = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) as total 
     FROM transactions 
     WHERE user_id = $1 
     AND is_income = false 
     AND date >= date_trunc('month', CURRENT_DATE)`,
    [userData.id]
  );
  
  const monthlyIncome = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) as total 
     FROM transactions 
     WHERE user_id = $1 
     AND is_income = true 
     AND date >= date_trunc('month', CURRENT_DATE)`,
    [userData.id]
  );
  
  const totalTx = await pool.query(
    'SELECT COUNT(*) as total FROM transactions WHERE user_id = $1',
    [userData.id]
  );
  
  return {
    ...userData,
    monthlyExpenses: parseFloat(monthlyExpenses.rows[0].total),
    monthlyIncome: parseFloat(monthlyIncome.rows[0].total),
    totalTransactions: parseInt(totalTx.rows[0].total)
  };
}

// ============================================
// HELPERS DE VARIACIÓN
// ============================================

// Obtener variación aleatoria de un array
function randomVariation(array) {
  return array[Math.floor(Math.random() * array.length)];
}

// Variaciones de confirmaciones
const confirmations = {
  transaction: [
    (category) => `¡Listo! Ya agregué el gasto de ${category}.`,
    (category) => `Anotado! Gasto de ${category} registrado.`,
    (category) => `Ok, guardé el gasto de ${category}.`,
    (category) => `Dale, ya quedó el gasto de ${category}.`,
    (category) => `Perfecto, gasto de ${category} anotado.`
  ],
  income: [
    (category) => `¡Genial! Ya agregué el ingreso de ${category}.`,
    (category) => `Dale! Ingreso de ${category} anotado.`,
    (category) => `Perfecto, ingreso de ${category} guardado.`,
    (category) => `Listo! Ya quedó el ingreso de ${category}.`
  ],
  budget: [
    (category) => `¡Listo! Presupuesto de ${category} configurado.`,
    (category) => `Dale! Ya está el presupuesto de ${category}.`,
    (category) => `Perfecto! Presupuesto de ${category} guardado.`,
    (category) => `Ok! Ya quedó el presupuesto de ${category}.`
  ],
  onboardingIncome: [
    () => `¡Dale! Tu ingreso mensual:`,
    () => `Perfecto! Tu ingreso:`,
    () => `Genial! Ganas al mes:`,
    () => `Excelente! Tu ingreso mensual:`
  ],
  alertIntro: [
    (name) => name ? `⚠️ Ojo ${name}, te cuento algo` : `⚠️ Ojo con los gastos`,
    (name) => name ? `⚠️ Hey ${name}` : `⚠️ Hey, te cuento algo`,
    () => `⚠️ Mira esto`,
    () => `⚠️ Atención con el presupuesto`
  ]
};

// ============================================
// CATEGORIES MANAGEMENT
// ============================================

// Obtener categorías válidas desde DB
async function getValidCategories(type = 'expense') {
  const result = await pool.query(
    `SELECT name, emoji FROM categories 
     WHERE type = $1 AND is_active = true 
     ORDER BY display_order`,
    [type]
  );
  return result.rows;
}

// Validar si categoría existe
async function isValidCategory(categoryName, type = 'expense') {
  const result = await pool.query(
    `SELECT EXISTS(
       SELECT 1 FROM categories 
       WHERE LOWER(name) = LOWER($1) AND type = $2 AND is_active = true
     ) as exists`,
    [categoryName, type]
  );
  return result.rows[0].exists;
}

// Obtener emoji de categoría
async function getCategoryEmoji(categoryName, type = 'expense') {
  const result = await pool.query(
    `SELECT emoji FROM categories
     WHERE LOWER(name) = LOWER($1) AND type = $2 AND is_active = true`,
    [categoryName, type]
  );
  // LOW SEVERITY FIX: Safe access with fallback (already using optional chaining, but add logging)
  if (result.rows.length === 0) {
    console.log(`⚠️ Category emoji not found: ${categoryName} (${type}), using default`);
  }
  return result.rows[0]?.emoji || '📦';
}

// Formatear lista de categorías para mostrar al usuario
async function formatCategoriesList(type = 'expense') {
  const categories = await getValidCategories(type);
  return categories.map(c => `${c.emoji} ${c.name}`).join('\n');
}

// ============================================
// FIXED EXPENSES MANAGEMENT
// ============================================

// Lista de descripciones que sugieren gastos fijos
const FIXED_EXPENSE_KEYWORDS = [
  'arriendo', 'alquiler', 'renta',
  'luz', 'electricidad', 'enel', 'cge', 'chilectra',
  'agua', 'aguas andinas', 'esval', 'essbio',
  'gas', 'metrogas', 'lipigas', 'gasco',
  'internet', 'vtr', 'movistar', 'entel', 'claro', 'wom', 'mundo pacifico',
  'telefono', 'celular', 'plan movil',
  'netflix', 'spotify', 'disney', 'hbo', 'amazon prime', 'youtube premium',
  'apple music', 'deezer', 'crunchyroll', 'paramount',
  'gimnasio', 'gym', 'smart fit', 'sportlife', 'pacific',
  'seguro', 'isapre', 'fonasa', 'afp',
  'colegio', 'universidad', 'jardin', 'mensualidad',
  'credito', 'hipotecario', 'dividendo', 'cuota', 'prestamo',
  'pension', 'alimenticia', 'gastos comunes', 'condominio',
  'suscripcion', 'membresia', 'chatgpt', 'openai', 'notion', 'slack',
  'icloud', 'google one', 'dropbox', 'adobe', 'microsoft 365', 'office'
];

// Detectar si una descripción parece un gasto fijo
function looksLikeFixedExpense(description) {
  if (!description) return false;
  const descLower = description.toLowerCase();
  return FIXED_EXPENSE_KEYWORDS.some(keyword => descLower.includes(keyword));
}

// Crear un gasto fijo
async function createFixedExpense(userId, description, amount, categoryId, reminderDay = null) {
  const result = await pool.query(
    `INSERT INTO fixed_expenses (user_id, description, typical_amount, category_id, reminder_day, is_active)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING *`,
    [userId, description, amount, categoryId, reminderDay]
  );
  return result.rows[0];
}

// Obtener gastos fijos de un usuario
async function getFixedExpenses(userId, onlyActive = true) {
  let query = `
    SELECT fe.*, c.name as category_name, c.emoji as category_emoji
    FROM fixed_expenses fe
    LEFT JOIN categories c ON fe.category_id = c.id
    WHERE fe.user_id = $1
  `;
  if (onlyActive) {
    query += ' AND fe.is_active = true';
  }
  query += ' ORDER BY fe.reminder_day NULLS LAST, fe.description';

  const result = await pool.query(query, [userId]);
  return result.rows;
}

// Obtener un gasto fijo por ID
async function getFixedExpenseById(id, userId) {
  const result = await pool.query(
    `SELECT fe.*, c.name as category_name, c.emoji as category_emoji
     FROM fixed_expenses fe
     LEFT JOIN categories c ON fe.category_id = c.id
     WHERE fe.id = $1 AND fe.user_id = $2`,
    [id, userId]
  );
  return result.rows[0] || null;
}

// Actualizar gasto fijo
async function updateFixedExpense(id, userId, updates) {
  const allowedFields = ['description', 'typical_amount', 'category_id', 'reminder_day', 'is_active'];
  const setClause = [];
  const values = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      setClause.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
  }

  if (setClause.length === 0) return null;

  setClause.push(`updated_at = NOW()`);
  values.push(id, userId);

  const result = await pool.query(
    `UPDATE fixed_expenses
     SET ${setClause.join(', ')}
     WHERE id = $${paramIndex} AND user_id = $${paramIndex + 1}
     RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

// Eliminar gasto fijo
async function deleteFixedExpense(id, userId) {
  const result = await pool.query(
    `DELETE FROM fixed_expenses WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId]
  );
  return result.rows[0] || null;
}

// Buscar gasto fijo por descripción (para evitar duplicados)
async function findFixedExpenseByDescription(userId, description) {
  const result = await pool.query(
    `SELECT * FROM fixed_expenses
     WHERE user_id = $1 AND LOWER(description) = LOWER($2)`,
    [userId, description]
  );
  return result.rows[0] || null;
}

// Obtener gastos fijos para recordatorio de un día específico
async function getFixedExpensesForReminderDay(day) {
  const result = await pool.query(
    `SELECT
      u.id as user_id,
      u.phone,
      u.name,
      json_agg(json_build_object(
        'id', fe.id,
        'description', fe.description,
        'amount', fe.typical_amount,
        'category', c.name,
        'emoji', c.emoji
      )) as expenses
    FROM fixed_expenses fe
    JOIN users u ON fe.user_id = u.id
    LEFT JOIN categories c ON fe.category_id = c.id
    WHERE fe.reminder_day = $1
      AND fe.is_active = true
      AND u.onboarding_complete = true
    GROUP BY u.id, u.phone, u.name`,
    [day]
  );
  return result.rows;
}

// Registrar todos los gastos fijos como transacciones
async function registerFixedExpensesAsTransactions(userId, expenses, month = null) {
  const results = [];
  const currentDate = new Date();
  const targetMonth = month || currentDate.toLocaleString('es-CL', { month: 'long' });

  for (const expense of expenses) {
    const result = await pool.query(
      `INSERT INTO transactions (user_id, amount, category_id, description, date, is_income, expense_type, fixed_expense_id)
       VALUES ($1, $2, $3, $4, CURRENT_DATE, false, 'fixed', $5)
       RETURNING *`,
      [userId, expense.amount || expense.typical_amount, expense.category_id, expense.description, expense.id]
    );
    results.push(result.rows[0]);
  }

  return results;
}

// Establecer pending_fixed_expense_id para conversación
async function setPendingFixedExpense(userId, fixedExpenseId) {
  await pool.query(
    'UPDATE users SET pending_fixed_expense_id = $1 WHERE id = $2',
    [fixedExpenseId, userId]
  );
}

// Limpiar pending_fixed_expense_id
async function clearPendingFixedExpense(userId) {
  await pool.query(
    'UPDATE users SET pending_fixed_expense_id = NULL WHERE id = $1',
    [userId]
  );
}

// Guardar IDs de transacciones mostradas al usuario
async function setLastShownTxIds(userId, txIds) {
  await pool.query(
    'UPDATE users SET last_shown_tx_ids = $1 WHERE id = $2',
    [JSON.stringify(txIds), userId]
  );
}

// Obtener IDs de transacciones mostradas
async function getLastShownTxIds(userId) {
  const result = await pool.query(
    'SELECT last_shown_tx_ids FROM users WHERE id = $1',
    [userId]
  );
  if (result.rows.length > 0 && result.rows[0].last_shown_tx_ids) {
    return JSON.parse(result.rows[0].last_shown_tx_ids);
  }
  return null;
}

// Extraer día del mensaje (ej: "5", "día 15", "el 20")
function extractReminderDay(message) {
  const cleaned = message.toLowerCase().trim();

  // Patrones para detectar día
  const patterns = [
    /^(\d{1,2})$/,                    // Solo número: "5"
    /d[ií]a\s*(\d{1,2})/,             // "día 15"
    /el\s*(\d{1,2})/,                 // "el 20"
    /cada\s*(\d{1,2})/,               // "cada 5"
    /los?\s*(\d{1,2})/,               // "los 15", "lo 15"
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match) {
      const day = parseInt(match[1]);
      if (day >= 1 && day <= 31) {
        return day;
      }
    }
  }

  return null;
}

// ============================================
// INCOME MANAGEMENT
// ============================================

// Calcular income efectivo (usado en alertas y cálculos)
async function getEffectiveMonthlyIncome(user) {
  // 1. Calcular ingresos del mes actual
  const currentMonth = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) as total 
     FROM transactions 
     WHERE user_id = $1 
     AND is_income = true 
     AND date >= date_trunc('month', CURRENT_DATE)`,
    [user.id]
  );
  const currentIncome = parseFloat(currentMonth.rows[0].total);
  
  // 2. Calcular promedio últimos 3 meses (excluyendo mes actual)
  const last3Months = await pool.query(
    `SELECT COALESCE(AVG(monthly_total), 0) as avg_income
     FROM (
       SELECT date_trunc('month', date) as month, 
              SUM(amount) as monthly_total
       FROM transactions
       WHERE user_id = $1 
       AND is_income = true
       AND date >= date_trunc('month', CURRENT_DATE) - INTERVAL '3 months'
       AND date < date_trunc('month', CURRENT_DATE)
       GROUP BY date_trunc('month', date)
       HAVING SUM(amount) > 0
     ) as monthly_totals`,
    [user.id]
  );
  const avgLast3Months = parseFloat(last3Months.rows[0].avg_income);
  
  // 3. Base inteligente = MAX(promedio_3_meses, income_onboarding)
  const baseIncome = Math.max(
    parseFloat(user.monthly_income), 
    avgLast3Months
  );
  
  // 4. Si hay ingresos este mes, usar el mayor
  if (currentIncome > 0) {
    return Math.max(baseIncome, currentIncome);
  }
  
  // 5. Si no hay ingresos este mes, usar base inteligente
  return baseIncome;
}

// Verificar si debe sugerir actualización de income
async function checkIncomeUpdatePrompt(user) {
  try {
    // 1. Verificar cooldown
    if (user.last_income_update_prompt) {
      const daysSinceLastPrompt = 
        (Date.now() - new Date(user.last_income_update_prompt)) / (1000 * 60 * 60 * 24);
      
      const cooldownDays = user.income_update_declined ? 
        INCOME_UPDATE_CONFIG.COOLDOWN_DAYS_DECLINED : 
        INCOME_UPDATE_CONFIG.COOLDOWN_DAYS_NORMAL;
      
      if (daysSinceLastPrompt < cooldownDays) {
        console.log(`⏰ Income update prompt on cooldown (${daysSinceLastPrompt.toFixed(0)}/${cooldownDays} days)`);
        return; // Muy pronto para preguntar
      }
    }
    
    // 2. Calcular promedio últimos 3 meses
    const last3Months = await pool.query(
      `SELECT COALESCE(AVG(monthly_total), 0) as avg_income,
              COUNT(*) as months_with_income
       FROM (
         SELECT date_trunc('month', date) as month, 
                SUM(amount) as monthly_total
         FROM transactions
         WHERE user_id = $1 
         AND is_income = true
         AND date >= date_trunc('month', CURRENT_DATE) - INTERVAL '3 months'
         AND date < date_trunc('month', CURRENT_DATE)
         GROUP BY date_trunc('month', date)
         HAVING SUM(amount) > 0
       ) as monthly_totals`,
      [user.id]
    );
    
    const avgIncome = parseFloat(last3Months.rows[0].avg_income);
    const monthsWithIncome = parseInt(last3Months.rows[0].months_with_income);
    
    console.log(`📊 Income check: avg=${avgIncome}, months=${monthsWithIncome}, current=${user.monthly_income}`);
    
    // 3. Verificar si hay suficiente historial
    if (monthsWithIncome < INCOME_UPDATE_CONFIG.MIN_MONTHS_HISTORY) {
      console.log(`⏳ Not enough history (${monthsWithIncome}/${INCOME_UPDATE_CONFIG.MIN_MONTHS_HISTORY} months)`);
      return; // Necesita al menos N meses de datos
    }
    
    // 4. Calcular diferencia
    const currentIncome = parseFloat(user.monthly_income);

    // HIGH SEVERITY FIX: Prevent division by zero
    if (!currentIncome || currentIncome <= 0) {
      console.log(`⚠️ Invalid currentIncome: ${currentIncome}, skipping income update prompt`);
      return;
    }

    const difference = avgIncome - currentIncome;
    const percentDiff = Math.abs(difference / currentIncome * 100);
    
    console.log(`💰 Income difference: ${percentDiff.toFixed(1)}% (threshold: ${INCOME_UPDATE_CONFIG.DIFF_THRESHOLD_PERCENT}%)`);
    
    // 5. Solo preguntar si diferencia > umbral
    if (percentDiff < INCOME_UPDATE_CONFIG.DIFF_THRESHOLD_PERCENT) {
      console.log(`✓ Difference not significant`);
      return; // Diferencia no significativa
    }
    
    // 6. Guardar que preguntamos
    await pool.query(
      'UPDATE users SET last_income_update_prompt = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );
    
    console.log(`💡 Sending income update prompt...`);
    
    // 7. Enviar pregunta
    const nameGreeting = user.name ? `${user.name}, ` : '';
    
    await sendWhatsApp(user.phone,
      `\n💡 Hey ${nameGreeting}noté algo:\n\n` +
      `Tu ingreso mensual declarado es $${currentIncome.toLocaleString('es-CL')}\n` +
      `Pero en los últimos meses has ganado en promedio $${Math.round(avgIncome).toLocaleString('es-CL')}\n\n` +
      `¿Quieres actualizar tu ingreso base a $${Math.round(avgIncome).toLocaleString('es-CL')}?\n` +
      `(Esto mejorará tus alertas y proyecciones)\n\n` +
      `Responde: "Sí" o "No"`
    );
    
    console.log(`✅ Income update prompt sent`);
    
  } catch (error) {
    console.error('❌ Error in checkIncomeUpdatePrompt:', error);
    // No romper el flujo principal
  }
}

// Manejar respuesta a sugerencia de actualización de income
async function handleIncomeUpdateResponse(user, data) {
  const { accepted } = data;
  
  if (accepted) {
    // Usuario aceptó actualizar
    
    // Calcular promedio últimos 3 meses
    const last3Months = await pool.query(
      `SELECT COALESCE(AVG(monthly_total), 0) as avg_income
       FROM (
         SELECT date_trunc('month', date) as month, 
                SUM(amount) as monthly_total
         FROM transactions
         WHERE user_id = $1 
         AND is_income = true
         AND date >= date_trunc('month', CURRENT_DATE) - INTERVAL '3 months'
         AND date < date_trunc('month', CURRENT_DATE)
         GROUP BY date_trunc('month', date)
         HAVING SUM(amount) > 0
       ) as monthly_totals`,
      [user.id]
    );
    
    const newIncome = Math.round(parseFloat(last3Months.rows[0].avg_income));
    
    // Actualizar income y resetear flag de declined
    await pool.query(
      'UPDATE users SET monthly_income = $1, income_update_declined = false WHERE id = $2',
      [newIncome, user.id]
    );
    
    console.log(`✅ Income updated: ${user.monthly_income} → ${newIncome}`);
    
    await sendWhatsApp(user.phone,
      `¡Listo! Tu ingreso mensual actualizado a $${newIncome.toLocaleString('es-CL')} ✅\n\n` +
      `Ahora tus alertas y proyecciones serán más precisas.`
    );
    
  } else {
    // Usuario rechazó actualizar
    
    await pool.query(
      'UPDATE users SET income_update_declined = true WHERE id = $1',
      [user.id]
    );
    
    console.log(`❌ User declined income update`);
    
    await sendWhatsApp(user.phone,
      `Ok, mantengo tu ingreso en $${parseFloat(user.monthly_income).toLocaleString('es-CL')}.\n\n` +
      `Te preguntaré de nuevo en unos meses. Si cambias de opinión, puedes decirme: "Actualizar ingreso a [monto]"`
    );
  }
}

// Manejar reclasificación de última transacción
async function handleReclassifyTransaction(user, data) {
  const { new_category } = data;
  
  if (!new_category) {
    await sendWhatsApp(user.phone, 
      '🤔 No entendí a qué categoría quieres cambiar el gasto.\n\n' +
      'Prueba: "Ese gasto debería ir en comida"'
    );
    return;
  }
  
  // Normalizar categoría
  const categoryLower = new_category.toLowerCase().trim();
  
  // Obtener category_id de la nueva categoría
  const newCategoryResult = await pool.query(
    `SELECT id, name, emoji FROM categories 
     WHERE LOWER(name) = $1 AND type = 'expense' AND is_active = true`,
    [categoryLower]
  );
  
  if (newCategoryResult.rows.length === 0) {
    // Categoría no válida - mostrar lista completa
    const categoriesList = await formatCategoriesList('expense');
    
    await sendWhatsApp(user.phone,
      `🤔 No reconozco la categoría "${new_category}".\n\n` +
      `Categorías válidas:\n\n${categoriesList}`
    );
    return;
  }
  
  const newCategoryId = newCategoryResult.rows[0].id;
  const newCategoryName = newCategoryResult.rows[0].name;
  const newEmoji = newCategoryResult.rows[0].emoji;
  
  // Buscar última transacción del usuario (< 5 minutos) con JOIN
  const result = await pool.query(
    `SELECT t.id, t.category_id, c.name as category, c.emoji as old_emoji, 
            t.amount, t.description, t.is_income 
     FROM transactions t
     JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = $1 
       AND t.created_at >= NOW() - INTERVAL '5 minutes'
     ORDER BY t.created_at DESC
     LIMIT 1`,
    [user.id]
  );
  
  if (result.rows.length === 0) {
    await sendWhatsApp(user.phone,
      '🤔 No encontré gastos recientes para reclasificar.\n\n' +
      '¿Registraste un gasto hace poco? (Solo puedo reclasificar gastos de los últimos 5 minutos)'
    );
    return;
  }
  
  const transaction = result.rows[0];
  
  // Verificar que no sea un ingreso
  if (transaction.is_income) {
    await sendWhatsApp(user.phone,
      '⚠️ Eso fue un ingreso, no un gasto.\n\n' +
      'Solo puedo reclasificar gastos.'
    );
    return;
  }
  
  // Verificar si ya está en esa categoría
  if (transaction.category_id === newCategoryId) {
    await sendWhatsApp(user.phone,
      `✓ Ya está clasificado en ${newCategoryName}.`
    );
    return;
  }
  
  const oldCategory = transaction.category;
  const oldEmoji = transaction.old_emoji;
  
  // Actualizar categoría con category_id
  await pool.query(
    'UPDATE transactions SET category_id = $1 WHERE id = $2',
    [newCategoryId, transaction.id]
  );
  
  console.log(`♻️ Transaction reclassified: ${oldCategory} → ${newCategoryName}`);
  
  // Confirmar
  let reply = `Ok! Reclasifiqué de ${oldEmoji} ${oldCategory} → ${newEmoji} ${newCategoryName} ✅\n\n`;
  reply += `💵 $${Number(transaction.amount).toLocaleString('es-CL')}`;
  if (transaction.description) {
    reply += `\n📝 ${transaction.description}`;
  }
  
  await sendWhatsApp(user.phone, reply);
}

// Manejar consulta de categorías disponibles
async function handleQueryCategories(user) {
  const expenseCategories = await formatCategoriesList('expense');
  const incomeCategories = await formatCategoriesList('income');

  const reply =
    `📊 Categorías disponibles:\n\n` +
    `💸 GASTOS:\n${expenseCategories}\n\n` +
    `💰 INGRESOS:\n${incomeCategories}`;

  await sendWhatsApp(user.phone, reply);
}

// ============================================
// FIXED EXPENSES HANDLERS
// ============================================

// Handler: Ver lista de gastos fijos
async function handleFixedExpensesList(user) {
  const fixedExpenses = await getFixedExpenses(user.id, false); // Incluir inactivos

  if (fixedExpenses.length === 0) {
    await sendWhatsApp(user.phone,
      '📌 No tienes gastos fijos configurados.\n\n' +
      'Para agregar uno, escribe:\n' +
      '"gasto fijo arriendo 450000"'
    );
    return;
  }

  let reply = '📌 Tus gastos fijos:\n\n';
  let totalActive = 0;

  fixedExpenses.forEach((expense, index) => {
    const emoji = expense.category_emoji || '💸';
    const amount = parseFloat(expense.typical_amount);
    const dayText = expense.reminder_day ? `día ${expense.reminder_day}` : 'sin recordatorio';
    const statusIcon = expense.is_active ? '' : ' ⏸️';

    reply += `${index + 1}. ${emoji} ${expense.description} - $${amount.toLocaleString('es-CL')} (${dayText})${statusIcon}\n`;

    if (expense.is_active) {
      totalActive += amount;
    }
  });

  reply += `\n━━━━━━━━━━━━━\n`;
  reply += `Total mensual estimado: $${totalActive.toLocaleString('es-CL')}\n\n`;
  reply += `Comandos:\n`;
  reply += `"editar fijo 1" | "eliminar fijo 2" | "pausar fijo 3"`;

  await sendWhatsApp(user.phone, reply);
}

// Handler: Editar gasto fijo
async function handleEditFixedExpense(user, data) {
  const { index } = data;

  if (!index || index < 1) {
    await sendWhatsApp(user.phone,
      '🤔 Indica el número del gasto fijo a editar.\n' +
      'Ej: "editar fijo 1"'
    );
    return;
  }

  const fixedExpenses = await getFixedExpenses(user.id, false);

  if (index > fixedExpenses.length) {
    await sendWhatsApp(user.phone,
      `❌ No existe el gasto fijo #${index}.\n` +
      `Tienes ${fixedExpenses.length} gastos fijos. Escribe "mis fijos" para verlos.`
    );
    return;
  }

  const expense = fixedExpenses[index - 1];
  const emoji = expense.category_emoji || '💸';
  const dayText = expense.reminder_day ? `día ${expense.reminder_day}` : 'sin día';

  // Guardar el ID para la siguiente respuesta
  await setPendingFixedExpense(user.id, expense.id);

  await sendWhatsApp(user.phone,
    `Editando: ${emoji} ${expense.description} $${parseFloat(expense.typical_amount).toLocaleString('es-CL')} (${dayText})\n\n` +
    `¿Qué quieres cambiar?\n` +
    `• Monto: escribe el nuevo (ej: "500000")\n` +
    `• Día: escribe "día X" (ej: "día 10")\n` +
    `• Ambos: "500000 día 10"\n` +
    `• Quitar recordatorio: "sin recordatorio"\n\n` +
    `O escribe "cancelar" para salir.`
  );
}

// Handler: Eliminar gasto fijo
async function handleDeleteFixedExpense(user, data) {
  const { index } = data;

  if (!index || index < 1) {
    await sendWhatsApp(user.phone,
      '🤔 Indica el número del gasto fijo a eliminar.\n' +
      'Ej: "eliminar fijo 1"'
    );
    return;
  }

  const fixedExpenses = await getFixedExpenses(user.id, false);

  if (index > fixedExpenses.length) {
    await sendWhatsApp(user.phone,
      `❌ No existe el gasto fijo #${index}.\n` +
      `Tienes ${fixedExpenses.length} gastos fijos. Escribe "mis fijos" para verlos.`
    );
    return;
  }

  const expense = fixedExpenses[index - 1];

  // Eliminar directamente
  await deleteFixedExpense(expense.id, user.id);

  await sendWhatsApp(user.phone,
    `✅ "${expense.description}" eliminado de tus gastos fijos.`
  );
}

// Handler: Pausar gasto fijo
async function handlePauseFixedExpense(user, data) {
  const { index } = data;

  if (!index || index < 1) {
    await sendWhatsApp(user.phone,
      '🤔 Indica el número del gasto fijo a pausar.\n' +
      'Ej: "pausar fijo 1"'
    );
    return;
  }

  const fixedExpenses = await getFixedExpenses(user.id, false);

  if (index > fixedExpenses.length) {
    await sendWhatsApp(user.phone,
      `❌ No existe el gasto fijo #${index}.\n` +
      `Tienes ${fixedExpenses.length} gastos fijos. Escribe "mis fijos" para verlos.`
    );
    return;
  }

  const expense = fixedExpenses[index - 1];

  if (!expense.is_active) {
    await sendWhatsApp(user.phone,
      `"${expense.description}" ya está pausado.\n` +
      `Escribe "activar fijo ${index}" para reactivarlo.`
    );
    return;
  }

  await updateFixedExpense(expense.id, user.id, { is_active: false });

  await sendWhatsApp(user.phone,
    `✅ "${expense.description}" pausado. No recibirás recordatorios hasta que lo reactives con "activar fijo ${index}".`
  );
}

// Handler: Activar gasto fijo
async function handleActivateFixedExpense(user, data) {
  const { index } = data;

  if (!index || index < 1) {
    await sendWhatsApp(user.phone,
      '🤔 Indica el número del gasto fijo a activar.\n' +
      'Ej: "activar fijo 1"'
    );
    return;
  }

  const fixedExpenses = await getFixedExpenses(user.id, false);

  if (index > fixedExpenses.length) {
    await sendWhatsApp(user.phone,
      `❌ No existe el gasto fijo #${index}.\n` +
      `Tienes ${fixedExpenses.length} gastos fijos. Escribe "mis fijos" para verlos.`
    );
    return;
  }

  const expense = fixedExpenses[index - 1];

  if (expense.is_active) {
    await sendWhatsApp(user.phone,
      `"${expense.description}" ya está activo.`
    );
    return;
  }

  await updateFixedExpense(expense.id, user.id, { is_active: true });

  await sendWhatsApp(user.phone,
    `✅ "${expense.description}" reactivado. Recibirás recordatorios ${expense.reminder_day ? `el día ${expense.reminder_day}` : 'cuando configures el día'}.`
  );
}

// Handler: Mostrar ayuda completa
async function handleHelp(user) {
  const helpMessage = `📚 *GUÍA DE ORDENATE*

💸 *GASTOS/INGRESOS*
"15000 almuerzo" | "5 lucas uber"
"Me pagaron 800000"

📌 *GASTOS FIJOS*
"Gasto fijo arriendo 450000"
"Mis fijos" | "Editar fijo 1" | "Pausar fijo 1"

📊 *CONSULTAS*
"¿Cuánto gasté hoy/semana/mes?"
"Detalle comida" | "Gastos de ayer"

💰 *PRESUPUESTOS*
"Máximo 300000 en comida"
"¿Cómo van mis presupuestos?"

✏️ *EDITAR GASTOS*
"Mis gastos" → ver lista
"Editar último" | "Borrar gasto 3"

🔄 "Reclasificar a transporte"
📋 "Categorías"
💡 "¿Cómo ahorro más?"

💡 Tips: Varios gastos → "5000 uber y 12000 almuerzo"`;

  await sendWhatsApp(user.phone, helpMessage);
}

// Handler: Eliminar cuenta (solicita confirmación)
async function handleDeleteAccount(user) {
  // Marcar que estamos esperando confirmación de eliminación (-998)
  await pool.query(
    'UPDATE users SET pending_fixed_expense_id = -998 WHERE id = $1',
    [user.id]
  );

  await sendWhatsApp(user.phone,
    '⚠️ *¿Estás seguro de eliminar tu cuenta?*\n\n' +
    'Se borrarán permanentemente:\n' +
    '• Todas tus transacciones\n' +
    '• Tus gastos fijos\n' +
    '• Tus presupuestos\n' +
    '• Tu configuración\n\n' +
    '❌ Esta acción NO se puede deshacer.\n\n' +
    'Escribe *"CONFIRMAR ELIMINAR"* para proceder\n' +
    'o *"cancelar"* para mantener tu cuenta.'
  );
}

// Handler: Listar gastos del mes
async function handleListMyExpenses(user) {
  const result = await pool.query(
    `SELECT t.id, t.amount, t.description, t.date, t.is_income, t.expense_type,
            c.name as category_name, c.emoji as category_emoji
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = $1
       AND t.date >= date_trunc('month', CURRENT_DATE)
     ORDER BY t.created_at DESC
     LIMIT 20`,
    [user.id]
  );

  if (result.rows.length === 0) {
    await sendWhatsApp(user.phone,
      '📋 No tienes gastos registrados este mes.\n\n' +
      'Registra uno diciendo por ejemplo: "Gasté 5000 en almuerzo"'
    );
    return;
  }

  // Guardar IDs de transacciones mostradas para poder editar por índice
  const txIds = result.rows.map(tx => tx.id);
  await setLastShownTxIds(user.id, txIds);

  let reply = '📋 *Tus gastos de este mes:*\n\n';

  result.rows.forEach((tx, index) => {
    const emoji = tx.category_emoji || '📦';
    const tipo = tx.is_income ? '💰' : '💸';
    const desc = tx.description || tx.category_name || 'Sin descripción';
    const fecha = new Date(tx.date).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
    const fijo = tx.expense_type === 'fixed' ? ' 📌' : '';

    reply += `${index + 1}. ${tipo} ${emoji} ${desc}: $${parseFloat(tx.amount).toLocaleString('es-CL')}${fijo}\n`;
    reply += `   📅 ${fecha}\n\n`;
  });

  reply += '━━━━━━━━━━━━━\n';
  reply += '📝 *Para modificar:*\n';
  reply += '• "editar gasto 3"\n';
  reply += '• "borrar gasto 5"';

  await sendWhatsApp(user.phone, reply);
}

// Handler: Editar último gasto (ventana de 5 minutos)
async function handleEditLastExpense(user) {
  // Buscar el último gasto del usuario (últimos 5 minutos)
  const result = await pool.query(
    `SELECT t.id, t.amount, t.description, t.date, t.is_income,
            c.name as category_name, c.emoji as category_emoji
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = $1
       AND t.created_at >= NOW() - INTERVAL '5 minutes'
     ORDER BY t.created_at DESC
     LIMIT 1`,
    [user.id]
  );

  if (result.rows.length === 0) {
    await sendWhatsApp(user.phone,
      '🤔 No encontré gastos recientes (últimos 5 minutos).\n\n' +
      'Para editar gastos más antiguos, escribe "mis gastos" y selecciona el número.'
    );
    return;
  }

  const tx = result.rows[0];
  const emoji = tx.category_emoji || '📦';
  const desc = tx.description || tx.category_name || 'Sin descripción';

  // Guardar ID de transacción para edición (usamos -2000 - txId para diferenciarlo)
  await pool.query(
    'UPDATE users SET pending_fixed_expense_id = $1 WHERE id = $2',
    [-2000 - tx.id, user.id]
  );

  await sendWhatsApp(user.phone,
    `✏️ *Editando:* ${emoji} ${desc} - $${parseFloat(tx.amount).toLocaleString('es-CL')}\n\n` +
    `¿Qué quieres hacer?\n` +
    `• Cambiar monto: escribe el nuevo (ej: "50000")\n` +
    `• Cambiar descripción: escribe "desc: nueva descripción"\n` +
    `• Eliminar: escribe "eliminar"\n\n` +
    `O escribe "cancelar" para salir.`
  );
}

// Handler: Eliminar último gasto
async function handleDeleteLastExpense(user) {
  // Buscar el último gasto del usuario (últimos 5 minutos)
  const result = await pool.query(
    `SELECT t.id, t.amount, t.description,
            c.name as category_name, c.emoji as category_emoji
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = $1
       AND t.created_at >= NOW() - INTERVAL '5 minutes'
     ORDER BY t.created_at DESC
     LIMIT 1`,
    [user.id]
  );

  if (result.rows.length === 0) {
    await sendWhatsApp(user.phone,
      '🤔 No encontré gastos recientes (últimos 5 minutos).\n\n' +
      'Para eliminar gastos más antiguos, escribe "mis gastos" y selecciona el número.'
    );
    return;
  }

  const tx = result.rows[0];
  const emoji = tx.category_emoji || '📦';
  const desc = tx.description || tx.category_name || 'Sin descripción';

  // Eliminar la transacción
  await pool.query('DELETE FROM transactions WHERE id = $1 AND user_id = $2', [tx.id, user.id]);

  await sendWhatsApp(user.phone,
    `🗑️ Eliminado: ${emoji} ${desc} - $${parseFloat(tx.amount).toLocaleString('es-CL')}`
  );
}

// Handler: Editar gasto por índice (de la lista)
async function handleEditExpense(user, data) {
  const { index } = data;

  if (!index || index < 1) {
    await sendWhatsApp(user.phone,
      '🤔 Indica el número del gasto a editar.\n' +
      'Primero escribe "mis gastos" para ver la lista.'
    );
    return;
  }

  // Intentar obtener los IDs de la última lista mostrada
  const lastShownIds = await getLastShownTxIds(user.id);

  let txId;
  if (lastShownIds && index <= lastShownIds.length) {
    // Usar el ID guardado de la última lista mostrada
    txId = lastShownIds[index - 1];
  } else {
    // Fallback: obtener los gastos del mes
    const result = await pool.query(
      `SELECT t.id FROM transactions t
       WHERE t.user_id = $1
         AND t.date >= date_trunc('month', CURRENT_DATE)
       ORDER BY t.created_at DESC
       LIMIT 20`,
      [user.id]
    );

    if (index > result.rows.length) {
      await sendWhatsApp(user.phone,
        `❌ No existe el gasto #${index}.\n` +
        `Escribe "mis gastos" para ver la lista actual.`
      );
      return;
    }
    txId = result.rows[index - 1].id;
  }

  // Obtener detalles de la transacción
  const result = await pool.query(
    `SELECT t.id, t.amount, t.description,
            c.name as category_name, c.emoji as category_emoji
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.id = $1 AND t.user_id = $2`,
    [txId, user.id]
  );

  if (result.rows.length === 0) {
    await sendWhatsApp(user.phone,
      `❌ No encontré el gasto #${index}.\n` +
      `Escribe "mis gastos" para ver la lista actualizada.`
    );
    return;
  }

  const tx = result.rows[0];
  const emoji = tx.category_emoji || '📦';
  const desc = tx.description || tx.category_name || 'Sin descripción';

  // Guardar ID de transacción para edición
  await pool.query(
    'UPDATE users SET pending_fixed_expense_id = $1 WHERE id = $2',
    [-2000 - tx.id, user.id]
  );

  await sendWhatsApp(user.phone,
    `✏️ *Editando gasto #${index}:* ${emoji} ${desc} - $${parseFloat(tx.amount).toLocaleString('es-CL')}\n\n` +
    `¿Qué quieres hacer?\n` +
    `• Cambiar monto: escribe el nuevo (ej: "50000")\n` +
    `• Cambiar descripción: escribe "desc: nueva descripción"\n` +
    `• Eliminar: escribe "eliminar"\n\n` +
    `O escribe "cancelar" para salir.`
  );
}

// Handler: Eliminar gasto por índice
async function handleDeleteExpense(user, data) {
  const { index } = data;

  if (!index || index < 1) {
    await sendWhatsApp(user.phone,
      '🤔 Indica el número del gasto a eliminar.\n' +
      'Primero escribe "mis gastos" para ver la lista.'
    );
    return;
  }

  // Intentar obtener los IDs de la última lista mostrada
  const lastShownIds = await getLastShownTxIds(user.id);

  let txId;
  if (lastShownIds && index <= lastShownIds.length) {
    // Usar el ID guardado de la última lista mostrada
    txId = lastShownIds[index - 1];
  } else {
    // Fallback: obtener los gastos del mes
    const result = await pool.query(
      `SELECT t.id FROM transactions t
       WHERE t.user_id = $1
         AND t.date >= date_trunc('month', CURRENT_DATE)
       ORDER BY t.created_at DESC
       LIMIT 20`,
      [user.id]
    );

    if (index > result.rows.length) {
      await sendWhatsApp(user.phone,
        `❌ No existe el gasto #${index}.\n` +
        `Escribe "mis gastos" para ver la lista actual.`
      );
      return;
    }
    txId = result.rows[index - 1].id;
  }

  // Obtener detalles de la transacción antes de eliminar
  const result = await pool.query(
    `SELECT t.id, t.amount, t.description,
            c.name as category_name, c.emoji as category_emoji
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.id = $1 AND t.user_id = $2`,
    [txId, user.id]
  );

  if (result.rows.length === 0) {
    await sendWhatsApp(user.phone,
      `❌ No encontré el gasto #${index}.\n` +
      `Escribe "mis gastos" para ver la lista actualizada.`
    );
    return;
  }

  const tx = result.rows[0];
  const emoji = tx.category_emoji || '📦';
  const desc = tx.description || tx.category_name || 'Sin descripción';

  // Eliminar la transacción
  await pool.query('DELETE FROM transactions WHERE id = $1 AND user_id = $2', [tx.id, user.id]);

  await sendWhatsApp(user.phone,
    `🗑️ Eliminado gasto #${index}: ${emoji} ${desc} - $${parseFloat(tx.amount).toLocaleString('es-CL')}`
  );
}

// Handler: Establecer día de recordatorio
async function handleSetReminderDay(user, data) {
  const { day, fixedExpenseId } = data;

  // Si viene de clasificación de Claude, usar el día del data
  const reminderDay = day || extractReminderDay(String(data.day));

  if (!reminderDay || reminderDay < 1 || reminderDay > 31) {
    await sendWhatsApp(user.phone,
      '🤔 El día debe ser un número entre 1 y 31.\n' +
      'Ej: "5", "día 15", "el 20"'
    );
    return;
  }

  // Si hay fixedExpenseId en data, usarlo; si no, usar pending
  const expenseId = fixedExpenseId || user.pending_fixed_expense_id;

  if (!expenseId || expenseId < 0) {
    // Es una transacción pendiente de conversión, no un fixed expense
    await sendWhatsApp(user.phone,
      '🤔 No hay un gasto fijo pendiente de configurar.\n' +
      'Primero registra un gasto fijo con "gasto fijo [descripción] [monto]"'
    );
    return;
  }

  // Actualizar reminder_day
  await updateFixedExpense(expenseId, user.id, { reminder_day: reminderDay });

  // Limpiar pending
  await clearPendingFixedExpense(user.id);

  await sendWhatsApp(user.phone,
    `✅ Listo, te recordaré el día ${reminderDay} de cada mes.`
  );
}

// Handler: Marcar gasto reciente como fijo
async function handleMarkAsFixed(user) {
  let pendingId = user.pending_fixed_expense_id;
  let transactionId = null;

  // Si no hay pendingId, buscar la última transacción del usuario (últimos 10 min)
  if (!pendingId) {
    const recentTx = await pool.query(
      `SELECT id FROM transactions
       WHERE user_id = $1
         AND is_income = false
         AND expense_type = 'variable'
         AND created_at >= NOW() - INTERVAL '10 minutes'
       ORDER BY created_at DESC
       LIMIT 1`,
      [user.id]
    );

    if (recentTx.rows.length === 0) {
      await sendWhatsApp(user.phone,
        '🤔 No encontré gastos recientes para marcar como fijo.\n\n' +
        'Registra un gasto primero o usa "gasto fijo [descripción] [monto]".'
      );
      return;
    }

    transactionId = recentTx.rows[0].id;
  } else if (pendingId < 0 && pendingId !== -999) {
    // Si es negativo, es el ID de una transacción pendiente de sugerencia
    transactionId = Math.abs(pendingId);
  } else if (pendingId > 0) {
    // Ya es un fixed_expense, probablemente esperando día
    await sendWhatsApp(user.phone,
      `¿Qué día del mes suele ser este gasto? (ej: "5" o "día 15")\n\n` +
      `Escribe "saltar" si no quieres recordatorio.`
    );
    return;
  } else {
    await sendWhatsApp(user.phone,
      '🤔 No hay un gasto para marcar como fijo.'
    );
    return;
  }

  // Obtener la transacción
  const txResult = await pool.query(
    `SELECT t.*, c.name as category_name, c.emoji as category_emoji
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.id = $1 AND t.user_id = $2`,
    [transactionId, user.id]
  );

  if (txResult.rows.length === 0) {
    await clearPendingFixedExpense(user.id);
    await sendWhatsApp(user.phone,
      '🤔 No encontré el gasto. Intenta registrarlo de nuevo como "gasto fijo [descripción] [monto]".'
    );
    return;
  }

  const tx = txResult.rows[0];

  // Verificar si ya existe como fixed_expense
  const existingFixed = await findFixedExpenseByDescription(user.id, tx.description);
  if (existingFixed && existingFixed.is_active) {
    await clearPendingFixedExpense(user.id);
    await sendWhatsApp(user.phone,
      `"${tx.description}" ya está en tus gastos fijos.`
    );
    return;
  }

  let fixedExpense;
  if (existingFixed) {
    // Reactivar el fixed_expense existente (fue rechazado antes)
    fixedExpense = await updateFixedExpense(existingFixed.id, user.id, {
      typical_amount: parseFloat(tx.amount),
      is_active: true
    });
  } else {
    // Crear nuevo fixed_expense
    fixedExpense = await createFixedExpense(
      user.id,
      tx.description || tx.category_name,
      parseFloat(tx.amount),
      tx.category_id,
      null
    );
  }

  // Actualizar transacción a fixed y linkear con fixed_expense
  await pool.query(
    'UPDATE transactions SET expense_type = $1, fixed_expense_id = $2 WHERE id = $3',
    ['fixed', fixedExpense.id, transactionId]
  );

  // Guardar para preguntar día
  await setPendingFixedExpense(user.id, fixedExpense.id);

  await sendWhatsApp(user.phone,
    `📌 "${tx.description}" marcado como fijo.\n\n` +
    `¿Qué día del mes suele ser? (ej: "5" o "día 15")\n` +
    `Escribe "saltar" si no quieres recordatorio.`
  );
}

// ============================================
// ONBOARDING CONVERSACIONAL
// ============================================

// Helper: Extraer monto de texto (maneja lucas, miles, etc)
function extractAmount(text) {
  // Limpiar texto
  const cleaned = text.toLowerCase()
    .replace(/\$/g, '')
    .replace(/\./g, '')
    .replace(/,/g, '');
  
  // Casos de texto comunes
  if (cleaned.match(/\b(un|1)\s*millon\b/)) return 1000000;
  if (cleaned.match(/\b(dos|2)\s*millones?\b/)) return 2000000;
  if (cleaned.match(/\b(tres|3)\s*millones?\b/)) return 3000000;
  if (cleaned.match(/\bmedio\s*millon\b/)) return 500000;
  if (cleaned.match(/\b(una|1)\s*(luca|lucas)\b/)) return 1000;
  
  // Buscar número seguido de "lucas", "luca", "mil", "k"
  let match = cleaned.match(/(\d+)\s*(lucas|luca|lukas|mil|k)/);
  if (match) {
    return parseInt(match[1]) * 1000;
  }
  
  // Buscar "palo" o "millón" con número
  match = cleaned.match(/(\d+)\s*(palo|palos|millon|millones)/);
  if (match) {
    return parseInt(match[1]) * 1000000;
  }
  
  // Buscar número simple
  match = cleaned.match(/(\d+)/);
  if (match) {
    return parseInt(match[1]);
  }
  
  return null;
}

async function handleOnboarding(user, message) {
  const amount = extractAmount(message);
  
  // Normalizar valores viejos (solo para casos edge legacy)
  let step = user.onboarding_step;
  if (step === 'responding_income') step = 'awaiting_income_response';
  
  switch(step) {
    case 'awaiting_name_response':
      // Validar que no sea un número o muy corto
      const name = message.trim();
      if (name.length < 2 || /^\d+$/.test(name)) {
        await sendWhatsApp(user.phone,
          '🤔 Mmm, no detecté un nombre válido.\n\n' +
          '¿Cómo te llamas?'
        );
        return;
      }
      
      // Capitalizar primera letra
      const capitalizedName = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
      
      // Guardar nombre y pasar a pregunta de ingreso
      await pool.query(
        'UPDATE users SET name = $1, onboarding_step = $2 WHERE id = $3',
        [capitalizedName, 'awaiting_income', user.id]
      );
      
      await sendWhatsApp(user.phone,
        `¡Genial ${capitalizedName}! 👋\n\n` +
        '💰 ¿Cuánto ganas al mes aprox?\n' +
        '(Puedes decir "800 lucas" o "$800000")'
      );
      break;
    
    case 'awaiting_income':
      console.log(`💰 Processing income amount: ${amount}`);
      
      if (!amount || amount < 50000) {
        console.log(`❌ Invalid amount: ${amount}`);
        await sendWhatsApp(user.phone, 
          '🤔 Mmm, no pude detectar el monto.\n\n' +
          'Dime tu ingreso mensual.\n' +
          'Ej: "800000" o "800 lucas"'
        );
        return;
      }
      
      console.log(`✅ Valid amount, updating user...`);
      
      // Guardar ingreso y pasar a meta de ahorro
      try {
        await pool.query(
          'UPDATE users SET monthly_income = $1, onboarding_step = $2 WHERE id = $3',
          [amount, 'awaiting_savings_goal', user.id]
        );
        console.log(`✅ User updated successfully`);
      } catch (error) {
        console.error(`❌ Error updating user:`, error);
        throw error;
      }
      
      console.log(`🎲 Getting random confirmation...`);
      const incomeConfirm = randomVariation(confirmations.onboardingIncome)();
      console.log(`✅ Confirmation: ${incomeConfirm}`);
      
      console.log(`📤 Sending savings goal question...`);
      await sendWhatsApp(user.phone,
        `${incomeConfirm} $${amount.toLocaleString('es-CL')}\n\n` +
        '🎯 ¿Cuánto quieres ahorrar al mes?\n\n' +
        'Tip: Lo ideal es ahorrar entre 10-20% de lo que ganas.\n' +
        `(En tu caso, entre $${Math.round(amount * 0.1).toLocaleString('es-CL')} y $${Math.round(amount * 0.2).toLocaleString('es-CL')})`
      );
      console.log(`✅ Message sent successfully`);
      break;
      
    case 'awaiting_savings_goal':
      if (!amount || amount <= 0) {
        await sendWhatsApp(user.phone,
          '🤔 Mmm, no pude detectar el monto.\n\n' +
          'Dime cuánto quieres ahorrar al mes.\n' +
          'Ej: "100000" o "100 lucas"'
        );
        return;
      }
      
      const income = parseFloat(user.monthly_income);
      
      // Validar que la meta de ahorro sea razonable
      if (amount > income * 0.8) {
        await sendWhatsApp(user.phone,
          `⚠️ Ojo, esa meta es muy alta.\n\n` +
          `Quieres ahorrar $${amount.toLocaleString('es-CL')} pero ganas $${income.toLocaleString('es-CL')}.\n\n` +
          'Te sugiero algo más realista (máximo 80% de tu ingreso).\n\n' +
          '¿Cuánto quieres ahorrar al mes?'
        );
        return;
      }
      
      // Guardar meta y completar onboarding
      await pool.query(
        'UPDATE users SET savings_goal = $1, onboarding_complete = true WHERE id = $2',
        [amount, user.id]
      );

      // Recargar usuario para obtener nombre
      const updatedUser = await pool.query('SELECT name FROM users WHERE id = $1', [user.id]);
      // CRITICAL FIX: Check if user exists before accessing rows[0]
      const userName = (updatedUser.rows.length > 0 && updatedUser.rows[0].name) ? updatedUser.rows[0].name : '';
      const greeting = userName ? `¡Listo ${userName}!` : '¡Listo!';
      
      const spendingBudget = income - amount;
      
      await sendWhatsApp(user.phone,
        `🎉 ${greeting} Ya está todo configurado:\n\n` +
        `💰 Ganas al mes: $${income.toLocaleString('es-CL')}\n` +
        `🎯 Meta de ahorro: $${amount.toLocaleString('es-CL')} (${((amount/income)*100).toFixed(0)}%)\n` +
        `💸 Tienes para gastar: $${spendingBudget.toLocaleString('es-CL')}\n\n` +
        `━━━━━━━━━━━━━\n\n` +
        `📚 Así me usas:\n\n` +
        `📝 REGISTRAR GASTOS:\n` +
        `"Gasté 15000 en Jumbo"\n` +
        `"5 lucas en Uber"\n` +
        `"Almuerzo 8000"\n\n` +
        `📌 GASTOS FIJOS (arriendo, servicios, suscripciones):\n` +
        `"Gasto fijo arriendo 450000"\n` +
        `"Fijo Netflix 6990"\n` +
        `"Mis fijos" para ver todos\n\n` +
        `📊 CONSULTAR GASTOS:\n` +
        `"¿Cuánto gasté esta semana?"\n` +
        `"Detalle de comida del mes"\n\n` +
        `💰 PONER PRESUPUESTOS:\n` +
        `"Máximo 300000 en comida"\n\n` +
        `💡 PEDIRME CONSEJOS:\n` +
        `"¿Puedo comprar un auto de 5 palos?"\n` +
        `"¿Cómo ahorro más?"\n\n` +
        `✏️ EDITAR GASTOS:\n` +
        `"Mis gastos" para ver lista\n` +
        `"Editar último gasto" si te equivocaste\n\n` +
        `💡 Tips:\n` +
        `• Marca gastos como FIJOS y te recordaré cada mes\n` +
        `• Puedes registrar varios: "5000 uber y 12000 almuerzo"\n\n` +
        `¡Empieza registrando tu primer gasto! 🚀\n\n` +
        `━━━━━━━━━━━━━\n` +
        `📚 Escribe /ayuda en cualquier momento para ver todos los comandos.`
      );
      break;
  }
}

// ============================================
// ALERTAS INTELIGENTES
// ============================================

// Sistema de alertas inteligentes
async function checkFinancialHealth(user) {
  // Usar income efectivo (considera ingresos extras del mes)
  const income = await getEffectiveMonthlyIncome(user);
  const savingsGoal = parseFloat(user.savings_goal);
  const spendingBudget = income - savingsGoal;
  
  // Verificar si ya enviamos alerta hoy
  const alertCheck = await pool.query(
    `SELECT id FROM financial_alerts 
     WHERE user_id = $1 AND alert_type = 'financial_health' AND alert_date = CURRENT_DATE`,
    [user.id]
  );
  
  if (alertCheck.rows.length > 0) {
    return; // Ya enviamos alerta hoy
  }
  
  // Calcular gastos del mes actual con JOIN
  const spentResult = await pool.query(
    `SELECT 
       c.name as category,
       c.emoji,
       SUM(t.amount) as category_total
     FROM transactions t
     JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = $1 
       AND t.date >= date_trunc('month', CURRENT_DATE)
       AND t.is_income = false
     GROUP BY c.id, c.name, c.emoji
     ORDER BY category_total DESC`,
    [user.id]
  );
  
  if (spentResult.rows.length === 0) {
    return; // No hay gastos aún
  }

  const totalSpent = spentResult.rows.reduce((sum, row) => sum + parseFloat(row.category_total), 0);

  // HIGH SEVERITY FIX: Prevent division by zero
  if (!spendingBudget || spendingBudget <= 0) {
    console.log(`⚠️ Invalid spendingBudget: ${spendingBudget}, skipping financial health check`);
    return;
  }

  const percentageUsed = (totalSpent / spendingBudget) * 100;
  
  // Calcular días transcurridos y proyección
  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projectedTotal = Math.round((totalSpent / dayOfMonth) * daysInMonth);
  const projectedSavings = Math.round(income - projectedTotal);
  
  // Encontrar categoría más gastadora
  const topCategory = spentResult.rows[0];
  const topCategoryPercentage = (parseFloat(topCategory.category_total) / income) * 100;
  
  // CONDICIONES PARA ALERTA
  let shouldAlert = false;
  let alertType = '';
  let alertMessage = '';
  
  // Alerta 1: Gastos > 70% del presupuesto
  if (percentageUsed > 70 && percentageUsed < 100) {
    shouldAlert = true;
    alertType = 'high_spending';
    const alertIntro = randomVariation(confirmations.alertIntro)(user.name || '');
    alertMessage = `${alertIntro}\n\n` +
      `Llevas gastado $${totalSpent.toLocaleString('es-CL')} este mes (${percentageUsed.toFixed(0)}% de tu presupuesto).\n\n` +
      `💸 Tenías para gastar: $${spendingBudget.toLocaleString('es-CL')}\n` +
      `💰 Te quedan: $${(spendingBudget - totalSpent).toLocaleString('es-CL')}\n\n` +
      `⚠️ A este ritmo, tu meta de ahorro de $${savingsGoal.toLocaleString('es-CL')} está complicada.\n\n`;
  }
  
  // Alerta 2: Proyección indica que no alcanzará meta
  if (projectedSavings < savingsGoal * 0.8 && !shouldAlert) {
    shouldAlert = true;
    alertType = 'savings_risk';
    alertMessage = `🚨 Ojo, tu meta de ahorro está en riesgo\n\n` +
      `📈 Si sigues así, al final del mes:\n` +
      `Vas a gastar: $${projectedTotal.toLocaleString('es-CL')}\n` +
      `Vas a ahorrar: $${projectedSavings.toLocaleString('es-CL')}\n` +
      `Tu meta era: $${savingsGoal.toLocaleString('es-CL')}\n\n` +
      `💡 Tendrías que reducir gastos en $${(projectedTotal - spendingBudget).toLocaleString('es-CL')} para llegar.\n\n`;
  }
  
  // Alerta 3: Categoría específica > 30% del ingreso
  if (topCategoryPercentage > 30 && !shouldAlert) {
    shouldAlert = true;
    alertType = 'category_high';
    const emoji = topCategory.emoji || '💸';
    alertMessage = `💡 Te cuento algo\n\n` +
      `Estás gastando harto en ${emoji} ${topCategory.category}:\n` +
      `$${parseFloat(topCategory.category_total).toLocaleString('es-CL')} (${topCategoryPercentage.toFixed(0)}% de lo que ganas)\n\n` +
      `Lo ideal es que ninguna categoría pase del 30%.\n\n`;
  }
  
  // Si debe alertar, generar consejo con Claude
  if (shouldAlert) {
    const advice = await generateFinancialAdvice(user, {
      totalSpent,
      spendingBudget,
      percentageUsed,
      topCategory: topCategory.category,
      topCategoryAmount: parseFloat(topCategory.category_total),
      projectedSavings,
      savingsGoal,
      income
    });
    
    alertMessage += advice;
    
    // Registrar alerta para no repetir hoy
    await pool.query(
      `INSERT INTO financial_alerts (user_id, alert_type) VALUES ($1, $2)
       ON CONFLICT (user_id, alert_type, alert_date) DO NOTHING`,
      [user.id, 'financial_health']
    );
    
    await sendWhatsApp(user.phone, alertMessage);
  }
}

// Generar consejo financiero personalizado con Claude
async function generateFinancialAdvice(user, financialData) {
  const { totalSpent, spendingBudget, topCategory, topCategoryAmount, savingsGoal, income } = financialData;
  
  const prompt = `Eres un asesor financiero en Chile. Analiza esta situación y da un consejo específico y accionable en máximo 3 líneas:

Ingreso mensual: $${income.toLocaleString('es-CL')}
Meta de ahorro: $${savingsGoal.toLocaleString('es-CL')}
Presupuesto para gastos: $${spendingBudget.toLocaleString('es-CL')}
Gastado hasta ahora: $${totalSpent.toLocaleString('es-CL')}
Categoría más alta: ${topCategory} ($${topCategoryAmount.toLocaleString('es-CL')})

Responde SOLO con el consejo directo, sin preámbulos como "Consejo:" o "Te recomiendo:". Empieza directamente con la acción, por ejemplo: "Reduce ${topCategory} de $X a $Y..."`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: prompt
      }]
    });

    // MEDIUM SEVERITY FIX: Check if response.content exists before accessing
    if (!response.content || response.content.length === 0) {
      console.error('❌ Empty response from Claude API in generateFinancialAdvice');
      return `Trata de reducir gastos en ${topCategory} esta semana para volver al presupuesto.`;
    }

    return `${response.content[0].text}`;
  } catch (error) {
    console.error('❌ Error generating advice:', error);
    return `Trata de reducir gastos en ${topCategory} esta semana para volver al presupuesto.`;
  }
}

// ============================================
// HANDLERS
// ============================================

async function handleTransaction(user, data) {
  const { amount, category, description, is_income, is_fixed, ask_reminder_day } = data;

  // Obtener category_id desde DB
  const categoryName = (category || 'otros').toLowerCase();
  const categoryType = is_income ? 'income' : 'expense';

  const categoryResult = await pool.query(
    `SELECT id, name, emoji FROM categories
     WHERE LOWER(name) = $1 AND type = $2 AND is_active = true`,
    [categoryName, categoryType]
  );

  let categoryId, categoryRealName, categoryEmoji;
  if (categoryResult.rows.length === 0) {
    console.error(`❌ Category not found: ${categoryName} (${categoryType})`);
    // Fallback a "otros"
    const otrosResult = await pool.query(
      `SELECT id, name, emoji FROM categories WHERE name = 'otros' AND type = $1`,
      [categoryType]
    );

    // CRITICAL FIX: Check if "otros" category exists before accessing rows[0]
    if (otrosResult.rows.length === 0) {
      console.error(`❌ CRITICAL: "otros" fallback category not found for type ${categoryType}`);
      await sendWhatsApp(user.phone, '❌ Error: Categoría no encontrada. Por favor contacta al administrador.');
      return;
    }

    categoryId = otrosResult.rows[0].id;
    categoryRealName = otrosResult.rows[0].name;
    categoryEmoji = otrosResult.rows[0].emoji;
  } else {
    categoryId = categoryResult.rows[0].id;
    categoryRealName = categoryResult.rows[0].name;
    categoryEmoji = categoryResult.rows[0].emoji;
  }

  // Determinar expense_type
  const expenseType = is_fixed ? 'fixed' : 'variable';

  // Insertar transacción con category_id y expense_type
  const txResult = await pool.query(
    `INSERT INTO transactions (user_id, amount, category_id, description, date, is_income, expense_type)
     VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6)
     RETURNING id`,
    [user.id, amount, categoryId, description || '', is_income || false, expenseType]
  );

  const transactionId = txResult.rows[0].id;

  // Mensaje variado con nombre real de BD y emoji
  const variations = is_income ? confirmations.income : confirmations.transaction;
  const confirmMessage = randomVariation(variations)(`${categoryEmoji} ${categoryRealName}`);

  let reply = `${confirmMessage}\n\n`;
  reply += `💵 $${Number(amount).toLocaleString('es-CL')}\n`;
  if (description) reply += `📝 ${description}\n`;

  // Si es gasto fijo, crear registro en fixed_expenses y preguntar día
  if (is_fixed && !is_income) {
    reply += `📌 Marcado como FIJO\n`;

    // Crear o actualizar fixed_expense
    const existingFixed = await findFixedExpenseByDescription(user.id, description || categoryRealName);

    let fixedExpense;
    if (existingFixed) {
      // Actualizar monto si ya existe
      fixedExpense = await updateFixedExpense(existingFixed.id, user.id, {
        typical_amount: amount,
        category_id: categoryId,
        is_active: true
      });
    } else {
      // Crear nuevo fixed_expense
      fixedExpense = await createFixedExpense(
        user.id,
        description || categoryRealName,
        amount,
        categoryId,
        null // reminder_day se establecerá después
      );
    }

    // Linkear transacción con fixed_expense
    await pool.query(
      'UPDATE transactions SET fixed_expense_id = $1 WHERE id = $2',
      [fixedExpense.id, transactionId]
    );

    // Guardar referencia para pregunta de reminder_day
    if (ask_reminder_day && fixedExpense) {
      await setPendingFixedExpense(user.id, fixedExpense.id);

      await sendWhatsApp(user.phone, reply);

      // Preguntar día de recordatorio
      await sendWhatsApp(user.phone,
        '¿Qué día del mes suele ser este gasto? (ej: "5" o "día 15")\n\n' +
        'Escribe "saltar" si no quieres recordatorio.'
      );
      return;
    }
  }

  await sendWhatsApp(user.phone, reply);

  // Si parece gasto fijo pero no se marcó como tal, sugerir SOLO la primera vez
  if (!is_fixed && !is_income && looksLikeFixedExpense(description)) {
    // Verificar si ya existe un fixed_expense con esta descripción (activo o no)
    const existingFixed = await findFixedExpenseByDescription(user.id, description);

    // Solo sugerir si NO existe previamente (primera vez que registra este gasto)
    if (!existingFixed) {
      // Guardar referencia a la transacción para posible conversión
      await pool.query(
        'UPDATE users SET pending_fixed_expense_id = $1 WHERE id = $2',
        [-transactionId, user.id] // Usar negativo para indicar que es una transacción, no un fixed_expense
      );

      setTimeout(async () => {
        try {
          await sendWhatsApp(user.phone,
            '💡 ¿Este gasto se repite cada mes? Responde "fijo" para recordatorios.'
          );
        } catch (error) {
          console.error('❌ Error sending fixed suggestion:', error);
        }
      }, 1000);
      return;
    }
    // Si ya existe fixed_expense (activo o rechazado previamente), no preguntar de nuevo
  }

  // Verificar alertas de presupuesto (pasar category_id en vez de nombre)
  if (categoryId) {
    await checkBudgetAlerts(user, categoryId);
  }

  // Sistema de alertas inteligentes (solo para gastos, no ingresos)
  // Solo si el usuario completó el onboarding
  if (!is_income && user.monthly_income && user.savings_goal) {
    try {
      await checkFinancialHealth(user);
    } catch (error) {
      console.error('❌ Error in checkFinancialHealth:', error);
      // No romper el flujo si las alertas fallan
    }
  }

  // Verificar si debe sugerir actualización de income
  // Solo después de transacciones y si completó onboarding
  if (user.onboarding_complete) {
    try {
      await checkIncomeUpdatePrompt(user);
    } catch (error) {
      console.error('❌ Error in checkIncomeUpdatePrompt:', error);
      // No romper el flujo principal
    }
  }
}

// Handler: Múltiples transacciones en una línea
async function handleMultipleTransactions(user, data) {
  const { transactions } = data;

  if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
    await sendWhatsApp(user.phone, '🤔 No pude identificar las transacciones. Intenta de nuevo.');
    return;
  }

  let totalAmount = 0;
  let registeredList = [];

  for (const tx of transactions) {
    // Procesar cada transacción individualmente usando handleTransaction
    // Pero sin enviar mensajes individuales
    const { amount, category, description, is_income } = tx;

    if (!amount || amount <= 0) continue;

    // Buscar categoría
    const categoryResult = await pool.query(
      'SELECT id, name, emoji FROM categories WHERE LOWER(name) = LOWER($1)',
      [category || 'otros']
    );

    let categoryId, categoryName, categoryEmoji;
    if (categoryResult.rows.length === 0) {
      const otrosResult = await pool.query(
        "SELECT id, name, emoji FROM categories WHERE name = 'otros'"
      );
      categoryId = otrosResult.rows[0]?.id;
      categoryName = 'Otros';
      categoryEmoji = '📦';
    } else {
      categoryId = categoryResult.rows[0].id;
      categoryName = categoryResult.rows[0].name;
      categoryEmoji = categoryResult.rows[0].emoji || '📦';
    }

    // Insertar transacción
    await pool.query(
      `INSERT INTO transactions (user_id, amount, category_id, description, date, is_income, expense_type)
       VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, 'variable')`,
      [user.id, amount, categoryId, description || '', is_income || false]
    );

    totalAmount += amount;
    const displayName = description || categoryName;
    registeredList.push(`• ${categoryEmoji} ${displayName}: $${Number(amount).toLocaleString('es-CL')}`);
  }

  if (registeredList.length === 0) {
    await sendWhatsApp(user.phone, '🤔 No pude registrar ninguna transacción. Revisa los montos.');
    return;
  }

  const tipo = transactions.some(t => t.is_income) ? 'transacciones' : 'gastos';

  await sendWhatsApp(user.phone,
    `✅ Registré ${registeredList.length} ${tipo}:\n\n` +
    `${registeredList.join('\n')}\n\n` +
    `💰 Total: $${totalAmount.toLocaleString('es-CL')}`
  );
}

async function handleQuery(user, data) {
  const { period, category, detail } = data;
  
  let dateFilter = 'date >= CURRENT_DATE';
  let periodText = 'hoy';
  
  switch(period) {
    case 'today':
      dateFilter = 't.date = CURRENT_DATE';
      periodText = 'hoy';
      break;
    case 'yesterday':
      dateFilter = 't.date = CURRENT_DATE - INTERVAL \'1 day\'';
      periodText = 'ayer';
      break;
    case 'week':
      dateFilter = "t.date >= date_trunc('week', CURRENT_DATE)";
      periodText = 'esta semana';
      break;
    case 'month':
      dateFilter = "t.date >= date_trunc('month', CURRENT_DATE)";
      periodText = 'este mes';
      break;
    case 'year':
      dateFilter = "t.date >= date_trunc('year', CURRENT_DATE)";
      periodText = 'este año';
      break;
    case 'last_week':
      dateFilter = "t.date >= date_trunc('week', CURRENT_DATE - INTERVAL '1 week') AND t.date < date_trunc('week', CURRENT_DATE)";
      periodText = 'la semana pasada';
      break;
    case 'last_month':
      dateFilter = "t.date >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month') AND t.date < date_trunc('month', CURRENT_DATE)";
      periodText = 'el mes pasado';
      break;
  }
  
  // Obtener category_id si se especificó una categoría
  let categoryId = null;
  if (category) {
    const catResult = await pool.query(
      `SELECT id FROM categories WHERE LOWER(name) = LOWER($1) AND type = 'expense'`,
      [category]
    );
    if (catResult.rows.length > 0) {
      categoryId = catResult.rows[0].id;
    }
  }
  
  // Si pide detalle, mostrar transacciones individuales
  if (detail) {
    let query = `
      SELECT t.id, c.name as category, c.emoji, t.description, t.amount, t.date, t.is_income
      FROM transactions t
      JOIN categories c ON t.category_id = c.id
      WHERE t.user_id = $1 AND ${dateFilter}
    `;

    const params = [user.id];

    if (categoryId) {
      query += ` AND t.category_id = $2`;
      params.push(categoryId);
    }

    query += ' ORDER BY c.name, t.date DESC';

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      const catText = category ? ` en ${category}` : '';
      await sendWhatsApp(user.phone, `No tienes gastos registrados${catText} ${periodText} 📊`);
      return;
    }

    // Guardar IDs de transacciones mostradas para poder editar por índice
    const txIds = result.rows.map(tx => tx.id);
    await setLastShownTxIds(user.id, txIds);

    // Agrupar por categoría manteniendo índice global
    const byCategory = {};
    let totalExpenses = 0;
    let totalIncome = 0;
    let globalIndex = 0;

    result.rows.forEach(row => {
      if (!byCategory[row.category]) {
        byCategory[row.category] = {
          emoji: row.emoji,
          transactions: []
        };
      }
      globalIndex++;
      row.displayIndex = globalIndex;
      byCategory[row.category].transactions.push(row);

      if (row.is_income) {
        totalIncome += parseFloat(row.amount);
      } else {
        totalExpenses += parseFloat(row.amount);
      }
    });

    const catText = category ? ` - ${category.charAt(0).toUpperCase() + category.slice(1)}` : '';
    const nameGreeting = user.name ? `${user.name}, aquí está tu ` : '';
    let reply = `📊 ${nameGreeting}Detalle ${periodText}${catText}:\n\n`;

    // Mostrar cada categoría con sus transacciones
    Object.keys(byCategory).sort().forEach(cat => {
      const { emoji, transactions } = byCategory[cat];
      const catTotal = transactions.reduce((sum, t) => sum + parseFloat(t.amount), 0);

      reply += `${emoji} ${cat.charAt(0).toUpperCase() + cat.slice(1)}:\n`;

      transactions.forEach(transaction => {
        const date = new Date(transaction.date);
        const dateStr = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
        reply += `  ${transaction.displayIndex}. ${transaction.description || 'Sin descripción'}: $${Number(transaction.amount).toLocaleString('es-CL')} (${dateStr})\n`;
      });

      reply += `  Subtotal: $${catTotal.toLocaleString('es-CL')}\n\n`;
    });

    reply += `━━━━━━━━━━━━━\n`;
    reply += `Total gastado: $${totalExpenses.toLocaleString('es-CL')}`;

    if (totalIncome > 0) {
      reply += `\nTotal ingresos: $${totalIncome.toLocaleString('es-CL')}`;
      reply += `\nBalance: $${(totalIncome - totalExpenses).toLocaleString('es-CL')}`;
    }

    reply += `\n\n📝 "editar gasto X" | "borrar gasto X"`;

    await sendWhatsApp(user.phone, reply);
    return;
  }
  
  // Modo resumen (agregado por categoría y tipo de gasto)
  let query = `
    SELECT
      c.name as category,
      c.emoji,
      t.expense_type,
      SUM(CASE WHEN t.is_income = false THEN t.amount ELSE 0 END) as expenses,
      SUM(CASE WHEN t.is_income = true THEN t.amount ELSE 0 END) as income
    FROM transactions t
    JOIN categories c ON t.category_id = c.id
    WHERE t.user_id = $1 AND ${dateFilter}
  `;

  const params = [user.id];

  if (categoryId) {
    query += ` AND t.category_id = $2`;
    params.push(categoryId);
  }

  query += ' GROUP BY c.id, c.name, c.emoji, t.expense_type ORDER BY t.expense_type, expenses DESC';

  const result = await pool.query(query, params);
  
  if (result.rows.length === 0) {
    const catText = category ? ` en ${category}` : '';
    await sendWhatsApp(user.phone, `No tienes gastos registrados${catText} ${periodText} 📊`);
    return;
  }

  const catText = category ? ` - ${category.charAt(0).toUpperCase() + category.slice(1)}` : '';
  const nameGreeting = user.name ? `${user.name}, aquí está tu ` : '';
  let reply = `📊 ${nameGreeting}Resumen ${periodText}${catText}:\n\n`;

  // Separar por tipo de gasto
  const fixedExpenses = {};
  const variableExpenses = {};
  let totalFixed = 0;
  let totalVariable = 0;
  let totalIncome = 0;

  result.rows.forEach(row => {
    const expenses = parseFloat(row.expenses);
    const income = parseFloat(row.income);
    const expenseType = row.expense_type || 'variable';

    totalIncome += income;

    if (expenses > 0) {
      if (expenseType === 'fixed') {
        if (!fixedExpenses[row.category]) {
          fixedExpenses[row.category] = { emoji: row.emoji, amount: 0 };
        }
        fixedExpenses[row.category].amount += expenses;
        totalFixed += expenses;
      } else {
        if (!variableExpenses[row.category]) {
          variableExpenses[row.category] = { emoji: row.emoji, amount: 0 };
        }
        variableExpenses[row.category].amount += expenses;
        totalVariable += expenses;
      }
    }
  });

  const totalExpenses = totalFixed + totalVariable;

  // Mostrar ingresos si hay
  if (totalIncome > 0) {
    reply += `💰 Ingresos: $${totalIncome.toLocaleString('es-CL')}\n\n`;
  }

  // Mostrar gastos fijos
  if (Object.keys(fixedExpenses).length > 0) {
    const fixedPercent = totalIncome > 0 ? Math.round((totalFixed / totalIncome) * 100) : 0;
    reply += `📌 Gastos Fijos: $${totalFixed.toLocaleString('es-CL')}`;
    if (totalIncome > 0) reply += ` (${fixedPercent}%)`;
    reply += `\n`;

    Object.keys(fixedExpenses).sort().forEach(cat => {
      const { emoji, amount } = fixedExpenses[cat];
      reply += `   • ${emoji || '💸'} ${cat}: $${amount.toLocaleString('es-CL')}\n`;
    });
    reply += `\n`;
  }

  // Mostrar gastos variables
  if (Object.keys(variableExpenses).length > 0) {
    const variablePercent = totalIncome > 0 ? Math.round((totalVariable / totalIncome) * 100) : 0;
    reply += `🛒 Gastos Variables: $${totalVariable.toLocaleString('es-CL')}`;
    if (totalIncome > 0) reply += ` (${variablePercent}%)`;
    reply += `\n`;

    Object.keys(variableExpenses).sort((a, b) =>
      variableExpenses[b].amount - variableExpenses[a].amount
    ).forEach(cat => {
      const { emoji, amount } = variableExpenses[cat];
      reply += `   • ${emoji || '💸'} ${cat}: $${amount.toLocaleString('es-CL')}\n`;
    });
  }

  reply += `\n━━━━━━━━━━━━━\n`;

  if (totalIncome > 0) {
    const balance = totalIncome - totalExpenses;
    const sign = balance >= 0 ? '+' : '';
    reply += `💵 Balance: ${sign}$${balance.toLocaleString('es-CL')}`;
  } else {
    reply += `Total gastado: $${totalExpenses.toLocaleString('es-CL')}`;
  }

  await sendWhatsApp(user.phone, reply);
  
  // Mensaje de upgrade a Premium (solo si está habilitado)
  // MEDIUM SEVERITY FIX: Handle async operation properly to avoid race condition
  if (SHOW_PREMIUM_MESSAGE && user.plan === 'free') {
    setTimeout(() => {
      sendWhatsApp(user.phone,
        '💎 ¿Quieres ver gráficos y análisis detallados?\n\nUpgrade a Premium por $10/mes\nEscribe "premium" para más info'
      ).catch(err => {
        console.error('❌ Error sending premium message:', err);
      });
    }, 2000);
  }
}

async function handleBudget(user, data) {
  const { category, amount } = data;
  
  if (!category || !amount) {
    await sendWhatsApp(user.phone, 'Necesito la categoría y el monto. Ej: "Quiero gastar máximo $100000 en comida"');
    return;
  }
  
  // Obtener category_id
  const categoryResult = await pool.query(
    `SELECT id, name FROM categories 
     WHERE LOWER(name) = LOWER($1) AND type = 'expense' AND is_active = true`,
    [category]
  );
  
  if (categoryResult.rows.length === 0) {
    await sendWhatsApp(user.phone, `No reconozco la categoría "${category}".`);
    return;
  }
  
  const categoryId = categoryResult.rows[0].id;
  const categoryName = categoryResult.rows[0].name;
  
  // Upsert presupuesto con category_id
  await pool.query(
    `INSERT INTO budgets (user_id, category_id, monthly_limit)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, category_id) 
     DO UPDATE SET monthly_limit = $3`,
    [user.id, categoryId, amount]
  );
  
  const budgetConfirm = randomVariation(confirmations.budget)(categoryName);
  
  await sendWhatsApp(user.phone,
    `${budgetConfirm}\n\n💰 $${Number(amount).toLocaleString('es-CL')} al mes\n\nTe aviso cuando llegues al 80% y 100%.`
  );
}

async function handleBudgetStatus(user, data) {
  // Obtener todos los presupuestos del usuario con JOIN
  const budgetsResult = await pool.query(
    `SELECT b.category_id, c.name, c.emoji, b.monthly_limit
     FROM budgets b
     JOIN categories c ON b.category_id = c.id
     WHERE b.user_id = $1
     ORDER BY c.name`,
    [user.id]
  );
  
  if (budgetsResult.rows.length === 0) {
    await sendWhatsApp(user.phone, 
      '📊 Aún no tienes presupuestos configurados.\n\nPrueba diciendo:\n"Máximo 100000 en comida"'
    );
    return;
  }
  
  // Obtener mes actual para el título
  const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 
                  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const currentMonth = months[new Date().getMonth()];
  
  let reply = `💰 Estado de tus presupuestos (${currentMonth}):\n\n`;
  let totalBudget = 0;
  let totalSpent = 0;

  // MEDIUM SEVERITY FIX: Solve N+1 query problem by fetching all spending data in a single query
  const categoryIds = budgetsResult.rows.map(b => b.category_id);
  const spendingData = await pool.query(
    `SELECT category_id, COALESCE(SUM(amount), 0) as total
     FROM transactions
     WHERE user_id = $1 AND category_id = ANY($2)
     AND date >= date_trunc('month', CURRENT_DATE)
     AND is_income = false
     GROUP BY category_id`,
    [user.id, categoryIds]
  );

  // Create a map for quick lookup
  const spendingMap = {};
  spendingData.rows.forEach(row => {
    spendingMap[row.category_id] = parseFloat(row.total);
  });

  // Para cada presupuesto, calcular gasto del mes
  for (const budget of budgetsResult.rows) {
    const limit = parseFloat(budget.monthly_limit);
    totalBudget += limit;

    const spent = spendingMap[budget.category_id] || 0;
    totalSpent += spent;

    // HIGH SEVERITY FIX: Prevent division by zero
    const percentage = (limit > 0) ? (spent / limit) * 100 : 0;
    const available = limit - spent;
    
    const emoji = budget.emoji || '📦';
    const catName = budget.name.charAt(0).toUpperCase() + budget.name.slice(1);
    
    reply += `${emoji} ${catName}:\n`;
    reply += `  Presupuesto: $${limit.toLocaleString('es-CL')}\n`;
    reply += `  Gastado: $${spent.toLocaleString('es-CL')} (${percentage.toFixed(0)}%)`;
    
    // Agregar alertas visuales
    if (percentage >= 100) {
      reply += ' 🚨';
    } else if (percentage >= 80) {
      reply += ' ⚠️';
    } else if (percentage >= 50) {
      reply += ' 🟡';
    } else {
      reply += ' ✅';
    }
    
    reply += `\n  Disponible: $${available.toLocaleString('es-CL')}\n\n`;
  }
  
  reply += `━━━━━━━━━━━━━\n`;
  reply += `Total presupuestado: $${totalBudget.toLocaleString('es-CL')}\n`;
  reply += `Total gastado: $${totalSpent.toLocaleString('es-CL')} (${((totalSpent / totalBudget) * 100).toFixed(0)}%)`;
  
  await sendWhatsApp(user.phone, reply);
}

async function handleFinancialAdvice(user, data, originalQuestion) {
  // Verificar que tenga onboarding completo
  if (!user.monthly_income || !user.savings_goal) {
    await sendWhatsApp(user.phone,
      '🤔 Para darte consejos personalizados, necesito conocer tu situación financiera.\n\n' +
      'Por favor completa tu perfil primero:\n' +
      '1. ¿Cuál es tu ingreso mensual?\n' +
      '2. ¿Cuánto quieres ahorrar al mes?'
    );
    return;
  }
  
  const income = parseFloat(user.monthly_income);
  const savingsGoal = parseFloat(user.savings_goal);
  const spendingBudget = income - savingsGoal;
  
  // Obtener gastos del mes actual por categoría
  const spentResult = await pool.query(
    `SELECT 
       c.id as category_id,
       c.name as category,
       SUM(t.amount) as total
     FROM transactions t
     JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = $1 
       AND t.date >= date_trunc('month', CURRENT_DATE)
       AND t.is_income = false
     GROUP BY c.id, c.name
     ORDER BY total DESC`,
    [user.id]
  );
  
  const totalSpent = spentResult.rows.reduce((sum, row) => sum + parseFloat(row.total), 0);
  
  // Obtener presupuestos configurados
  const budgetsResult = await pool.query(
    `SELECT c.name as category, b.monthly_limit 
     FROM budgets b
     JOIN categories c ON b.category_id = c.id
     WHERE b.user_id = $1`,
    [user.id]
  );
  
  // Calcular proyección
  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projectedTotal = totalSpent > 0 ? Math.round((totalSpent / dayOfMonth) * daysInMonth) : 0;
  const projectedSavings = Math.round(income - projectedTotal);
  
  // Construir contexto para Claude
  let context = `Eres un asesor financiero en Chile. El usuario te pregunta: "${originalQuestion}"\n\n`;
  context += `CONTEXTO FINANCIERO DEL USUARIO:\n`;
  context += `- Ingreso mensual: $${income.toLocaleString('es-CL')}\n`;
  context += `- Meta de ahorro: $${savingsGoal.toLocaleString('es-CL')} (${((savingsGoal/income)*100).toFixed(0)}% del ingreso)\n`;
  context += `- Presupuesto disponible para gastos: $${spendingBudget.toLocaleString('es-CL')}\n\n`;
  
  context += `SITUACIÓN ACTUAL (este mes):\n`;
  context += `- Día ${dayOfMonth} de ${daysInMonth} del mes\n`;
  // HIGH SEVERITY FIX: Prevent division by zero
  const budgetPercentage = (spendingBudget > 0) ? ((totalSpent/spendingBudget)*100).toFixed(0) : '0';
  context += `- Gastado hasta ahora: $${totalSpent.toLocaleString('es-CL')} (${budgetPercentage}% del presupuesto)\n`;
  context += `- Disponible: $${(spendingBudget - totalSpent).toLocaleString('es-CL')}\n`;
  context += `- Proyección fin de mes: $${projectedTotal.toLocaleString('es-CL')} en gastos, $${projectedSavings.toLocaleString('es-CL')} de ahorro\n\n`;
  
  if (spentResult.rows.length > 0) {
    context += `GASTOS POR CATEGORÍA:\n`;
    spentResult.rows.forEach(row => {
      const percentage = (parseFloat(row.total) / income) * 100;
      context += `- ${row.category}: $${parseFloat(row.total).toLocaleString('es-CL')} (${percentage.toFixed(1)}% del ingreso)\n`;
    });
    context += `\n`;
    
    // Agregar detalle de transacciones de las top 3 categorías
    const topCategories = spentResult.rows.slice(0, 3);
    if (topCategories.length > 0) {
      context += `DETALLE DE TRANSACCIONES (top categorías):\n`;
      
      for (const topCat of topCategories) {
        const txResult = await pool.query(
          `SELECT description, amount, date 
           FROM transactions 
           WHERE user_id = $1 
             AND category_id = $2
             AND date >= date_trunc('month', CURRENT_DATE)
             AND is_income = false
           ORDER BY date DESC
           LIMIT 5`,
          [user.id, topCat.category_id]
        );
        
        if (txResult.rows.length > 0) {
          context += `\n${topCat.category}:\n`;
          txResult.rows.forEach(tx => {
            const desc = tx.description ? ` - ${tx.description}` : '';
            const date = new Date(tx.date).getDate();
            context += `  • ${date}/1: $${parseFloat(tx.amount).toLocaleString('es-CL')}${desc}\n`;
          });
        }
      }
      context += `\n`;
    }
  }
  
  if (budgetsResult.rows.length > 0) {
    context += `PRESUPUESTOS CONFIGURADOS:\n`;
    for (const budget of budgetsResult.rows) {
      const spent = spentResult.rows.find(r => r.category === budget.category);
      const spentAmount = spent ? parseFloat(spent.total) : 0;
      const percentage = (spentAmount / parseFloat(budget.monthly_limit)) * 100;
      context += `- ${budget.category}: $${spentAmount.toLocaleString('es-CL')} de $${parseFloat(budget.monthly_limit).toLocaleString('es-CL')} (${percentage.toFixed(0)}%)\n`;
    }
    context += `\n`;
  }
  
  context += `INSTRUCCIONES:\n`;
  context += `1. Responde la pregunta del usuario de manera personalizada basándote en SU contexto específico\n`;
  context += `2. Sé directo, práctico y empático\n`;
  context += `3. Si pregunta sobre comprar algo, analiza si puede permitírselo sin comprometer su meta de ahorro\n`;
  context += `4. Da consejos accionables y específicos basados en su comportamiento real\n`;
  context += `5. Tienes acceso al DETALLE DE TRANSACCIONES - úsalo para dar respuestas específicas, NO hagas preguntas sobre información que ya tienes\n`;
  context += `6. Usa máximo 5-6 líneas\n`;
  context += `7. Usa emojis relevantes pero no abuses`;
  
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{
        role: "user",
        content: context
      }]
    });

    // MEDIUM SEVERITY FIX: Check if response.content exists before accessing
    if (!response.content || response.content.length === 0) {
      console.error('❌ Empty response from Claude API in handleFinancialAdvice');
      await sendWhatsApp(user.phone,
        'Ups, tuve un problema generando el consejo. ¿Puedes intentar reformular tu pregunta? 🤔'
      );
      return;
    }

    await sendWhatsApp(user.phone, `💡 ${response.content[0].text}`);
  } catch (error) {
    console.error('❌ Error generating financial advice:', error);
    await sendWhatsApp(user.phone,
      'Ups, tuve un problema generando el consejo. ¿Puedes intentar reformular tu pregunta? 🤔'
    );
  }
}

async function checkBudgetAlerts(user, categoryId) {
  // Obtener presupuesto con JOIN para traer nombre y emoji
  const budgetResult = await pool.query(
    `SELECT b.monthly_limit, c.name, c.emoji
     FROM budgets b
     JOIN categories c ON b.category_id = c.id
     WHERE b.user_id = $1 AND b.category_id = $2`,
    [user.id, categoryId]
  );
  
  if (budgetResult.rows.length === 0) return;
  
  const { monthly_limit, name, emoji } = budgetResult.rows[0];
  const budget = parseFloat(monthly_limit);
  
  // Calcular gasto del mes con category_id
  const spentResult = await pool.query(
    `SELECT SUM(amount) as total FROM transactions 
     WHERE user_id = $1 AND category_id = $2 
     AND date >= date_trunc('month', CURRENT_DATE)
     AND is_income = false`,
    [user.id, categoryId]
  );
  
  const spent = parseFloat(spentResult.rows[0].total || 0);

  // HIGH SEVERITY FIX: Prevent division by zero
  if (!budget || budget <= 0) {
    console.log(`⚠️ Invalid budget: ${budget}, skipping budget alert`);
    return;
  }

  const percentage = (spent / budget) * 100;

  if (percentage >= 100) {
    await sendWhatsApp(user.phone, 
      `🚨 ¡Ojo! Te pasaste del presupuesto de ${emoji} ${name}:\n\nGastaste: $${spent.toLocaleString('es-CL')}\nTenías: $${budget.toLocaleString('es-CL')}`
    );
  } else if (percentage >= 80) {
    await sendWhatsApp(user.phone,
      `⚠️ Atención: Ya llevas ${percentage.toFixed(0)}% del presupuesto en ${emoji} ${name}`
    );
  }
}

// ============================================
// FUNCIONES AUXILIARES
// ============================================

async function getOrCreateUser(phone) {
  let result = await pool.query(
    'SELECT * FROM users WHERE phone = $1',
    [phone]
  );
  
  if (result.rows.length === 0) {
    // Usuario nuevo - empezar preguntando nombre
    result = await pool.query(
      'INSERT INTO users (phone, onboarding_complete, onboarding_step) VALUES ($1, false, $2) RETURNING *',
      [phone, 'awaiting_name']
    );
  }
  
  return result.rows[0];
}

async function sendWhatsApp(to, message) {
  try {
    // Limpiar formato del número del destinatario
    let cleanPhone = to.replace('whatsapp:', '').replace('+', '');
    if (!cleanPhone.startsWith('56')) {
      cleanPhone = '56' + cleanPhone.replace(/^0+/, '');
    }
    const toNumber = `whatsapp:+${cleanPhone}`;
    
    // Número de Twilio (ya incluye whatsapp: en la variable)
    const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER;
    
    console.log(`📤 Enviando a ${toNumber} desde ${fromNumber}`);
    
    await twilioClient.messages.create({
      body: message,
      from: fromNumber,
      to: toNumber
    });
    
    console.log(`✅ Mensaje enviado a ${toNumber}`);
  } catch (error) {
    console.error('❌ Twilio error:', error);
  }
}

// ============================================
// CRON ENDPOINTS - FIXED EXPENSES REMINDERS
// ============================================

// Secret para autenticar llamadas del cron
const CRON_SECRET = process.env.CRON_SECRET || 'ordenate-cron-secret-2026';

// Middleware para autenticar llamadas del cron
function authenticateCron(req, res, next) {
  // Aceptar tanto x-cron-secret header como Authorization Bearer
  const cronSecret = req.headers['x-cron-secret'];
  const authHeader = req.headers.authorization;

  let token = null;

  if (cronSecret) {
    token = cronSecret;
  } else if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }

  if (!token) {
    console.log('⚠️ CRON: Missing authentication header');
    return res.status(401).json({ error: 'Unauthorized - use x-cron-secret header' });
  }

  if (token !== CRON_SECRET) {
    console.log('⚠️ CRON: Invalid token');
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
}

// ============================================
// ADMIN AUTHENTICATION
// ============================================

// Middleware para autenticar admin dashboard
async function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return res.status(401).json({ error: 'Unauthorized - Basic auth required' });
  }

  // Decodificar Basic auth (base64 de "user:password")
  const base64Credentials = authHeader.substring(6);
  const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
  const [username, password] = credentials.split(':');

  const adminUser = process.env.ADMIN_USER;
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;

  if (!adminUser || !adminPasswordHash) {
    console.error('⚠️ ADMIN: Missing ADMIN_USER or ADMIN_PASSWORD_HASH env vars');
    return res.status(500).json({ error: 'Admin not configured' });
  }

  if (username !== adminUser) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  try {
    const passwordMatch = await bcrypt.compare(password, adminPasswordHash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    next();
  } catch (error) {
    console.error('⚠️ ADMIN: bcrypt error:', error);
    return res.status(500).json({ error: 'Authentication error' });
  }
}

// ============================================
// ADMIN API ENDPOINTS
// ============================================

// POST /api/admin/login - Verificar credenciales admin
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const adminUser = process.env.ADMIN_USER;
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;

  if (!adminUser || !adminPasswordHash) {
    console.error('⚠️ ADMIN: Missing env vars');
    return res.status(500).json({ error: 'Admin not configured' });
  }

  if (username !== adminUser) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  try {
    const passwordMatch = await bcrypt.compare(password, adminPasswordHash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Login exitoso - retornar token Base64 para usar en siguientes requests
    const token = Buffer.from(`${username}:${password}`).toString('base64');

    res.json({
      success: true,
      message: 'Login successful',
      token: token,  // El frontend guarda esto para los siguientes requests
      user: { username: adminUser }
    });
  } catch (error) {
    console.error('⚠️ ADMIN: Login error:', error);
    return res.status(500).json({ error: 'Authentication error' });
  }
});

// GET /api/admin/dashboard - KPIs principales
app.get('/api/admin/dashboard', authenticateAdmin, async (req, res) => {
  try {
    // Usuarios
    const usersStats = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE) as today,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('week', CURRENT_DATE)) as this_week,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', CURRENT_DATE)) as this_month
      FROM users
    `);

    // Usuarios por plan
    const usersByPlan = await pool.query(`
      SELECT p.name as plan_name, COUNT(u.id) as count
      FROM users u
      LEFT JOIN user_plans p ON u.plan_id = p.id
      GROUP BY p.name
    `);

    // Actividad (DAU, WAU, MAU)
    const activityStats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE DATE(last_interaction) = CURRENT_DATE) as dau,
        COUNT(*) FILTER (WHERE last_interaction >= date_trunc('week', CURRENT_DATE)) as wau,
        COUNT(*) FILTER (WHERE last_interaction >= date_trunc('month', CURRENT_DATE)) as mau
      FROM users
      WHERE last_interaction IS NOT NULL
    `);

    // Transacciones
    const txStats = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE) as today,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', CURRENT_DATE)) as this_month,
        COALESCE(SUM(amount) FILTER (WHERE is_income = false), 0) as total_expenses,
        COALESCE(SUM(amount) FILTER (WHERE is_income = true), 0) as total_income
      FROM transactions
    `);

    // Promedio de transacciones por usuario
    const avgTxPerUser = await pool.query(`
      SELECT ROUND(AVG(tx_count), 1) as avg_per_user
      FROM (
        SELECT user_id, COUNT(*) as tx_count
        FROM transactions
        GROUP BY user_id
      ) sub
    `);

    // Gastos fijos
    const fixedExpensesStats = await pool.query(`
      SELECT
        COUNT(DISTINCT user_id) as users_with_fixed,
        COUNT(*) as total_fixed,
        ROUND(AVG(typical_amount), 0) as avg_amount
      FROM fixed_expenses
      WHERE is_active = true
    `);

    // Formatear respuesta
    const users = usersStats.rows[0];
    const activity = activityStats.rows[0];
    const tx = txStats.rows[0];

    const byPlan = {};
    usersByPlan.rows.forEach(row => {
      byPlan[row.plan_name || 'sin_plan'] = parseInt(row.count);
    });

    res.json({
      users: {
        total: parseInt(users.total),
        today: parseInt(users.today),
        thisWeek: parseInt(users.this_week),
        thisMonth: parseInt(users.this_month),
        byPlan
      },
      activity: {
        dau: parseInt(activity.dau),
        wau: parseInt(activity.wau),
        mau: parseInt(activity.mau)
      },
      transactions: {
        total: parseInt(tx.total),
        today: parseInt(tx.today),
        thisMonth: parseInt(tx.this_month),
        totalExpenses: parseFloat(tx.total_expenses),
        totalIncome: parseFloat(tx.total_income),
        avgPerUser: parseFloat(avgTxPerUser.rows[0]?.avg_per_user || 0)
      },
      fixedExpenses: {
        usersWithFixed: parseInt(fixedExpensesStats.rows[0].users_with_fixed),
        totalFixed: parseInt(fixedExpensesStats.rows[0].total_fixed),
        avgAmount: parseFloat(fixedExpensesStats.rows[0].avg_amount || 0)
      }
    });
  } catch (error) {
    console.error('⚠️ ADMIN: Dashboard error:', error);
    res.status(500).json({ error: 'Error fetching dashboard data' });
  }
});

// GET /api/admin/users - Lista de usuarios con filtros y paginación
app.get('/api/admin/users', authenticateAdmin, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      plan,
      search,
      sortBy = 'created_at',
      sortOrder = 'desc'
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const validSortFields = ['created_at', 'last_interaction', 'name', 'phone'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'created_at';
    const order = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    let whereConditions = [];
    let params = [];
    let paramIndex = 1;

    // Filtro por plan
    if (plan) {
      whereConditions.push(`p.name = $${paramIndex}`);
      params.push(plan);
      paramIndex++;
    }

    // Búsqueda por teléfono o nombre
    if (search) {
      whereConditions.push(`(u.phone ILIKE $${paramIndex} OR u.name ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    const whereClause = whereConditions.length > 0
      ? 'WHERE ' + whereConditions.join(' AND ')
      : '';

    // Query principal
    const query = `
      SELECT
        u.id, u.phone, u.name, u.created_at, u.last_interaction,
        u.onboarding_complete, u.monthly_income, u.savings_goal,
        p.name as plan_name,
        (SELECT COUNT(*) FROM transactions WHERE user_id = u.id) as transaction_count,
        (SELECT COUNT(*) FROM fixed_expenses WHERE user_id = u.id AND is_active = true) as fixed_expense_count
      FROM users u
      LEFT JOIN user_plans p ON u.plan_id = p.id
      ${whereClause}
      ORDER BY u.${sortField} ${order}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(parseInt(limit), offset);

    const result = await pool.query(query, params);

    // Contar total para paginación
    const countQuery = `
      SELECT COUNT(*) as total
      FROM users u
      LEFT JOIN user_plans p ON u.plan_id = p.id
      ${whereClause}
    `;
    const countResult = await pool.query(countQuery, params.slice(0, -2));
    const total = parseInt(countResult.rows[0].total);

    res.json({
      users: result.rows.map(u => ({
        id: u.id,
        phone: u.phone,
        name: u.name,
        plan: u.plan_name || 'free',
        createdAt: u.created_at,
        lastInteraction: u.last_interaction,
        onboardingComplete: u.onboarding_complete,
        monthlyIncome: u.monthly_income,
        savingsGoal: u.savings_goal,
        transactionCount: parseInt(u.transaction_count),
        fixedExpenseCount: parseInt(u.fixed_expense_count)
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('⚠️ ADMIN: Users list error:', error);
    res.status(500).json({ error: 'Error fetching users' });
  }
});

// GET /api/admin/users/:id - Detalle de usuario
app.get('/api/admin/users/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Info básica del usuario
    const userResult = await pool.query(`
      SELECT
        u.*,
        p.name as plan_name, p.price as plan_price
      FROM users u
      LEFT JOIN user_plans p ON u.plan_id = p.id
      WHERE u.id = $1
    `, [id]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Estadísticas de transacciones
    const txStats = await pool.query(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(amount) FILTER (WHERE is_income = false), 0) as total_expenses,
        COALESCE(SUM(amount) FILTER (WHERE is_income = true), 0) as total_income,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', CURRENT_DATE)) as this_month
      FROM transactions
      WHERE user_id = $1
    `, [id]);

    // Últimas transacciones
    const recentTx = await pool.query(`
      SELECT t.*, c.name as category_name, c.emoji as category_emoji
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.user_id = $1
      ORDER BY t.created_at DESC
      LIMIT 10
    `, [id]);

    // Gastos fijos
    const fixedExpenses = await pool.query(`
      SELECT f.*, c.name as category_name, c.emoji as category_emoji
      FROM fixed_expenses f
      LEFT JOIN categories c ON f.category_id = c.id
      WHERE f.user_id = $1
      ORDER BY f.created_at DESC
    `, [id]);

    // Presupuestos
    const budgets = await pool.query(`
      SELECT b.*, c.name as category_name, c.emoji as category_emoji
      FROM budgets b
      LEFT JOIN categories c ON b.category_id = c.id
      WHERE b.user_id = $1
    `, [id]);

    res.json({
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        plan: user.plan_name || 'free',
        planPrice: user.plan_price,
        createdAt: user.created_at,
        lastInteraction: user.last_interaction,
        onboardingComplete: user.onboarding_complete,
        onboardingStep: user.onboarding_step,
        monthlyIncome: user.monthly_income,
        savingsGoal: user.savings_goal
      },
      stats: {
        totalTransactions: parseInt(txStats.rows[0].total),
        totalExpenses: parseFloat(txStats.rows[0].total_expenses),
        totalIncome: parseFloat(txStats.rows[0].total_income),
        transactionsThisMonth: parseInt(txStats.rows[0].this_month)
      },
      recentTransactions: recentTx.rows,
      fixedExpenses: fixedExpenses.rows,
      budgets: budgets.rows
    });
  } catch (error) {
    console.error('⚠️ ADMIN: User detail error:', error);
    res.status(500).json({ error: 'Error fetching user details' });
  }
});

// ============================================
// ADMIN COSTS ENDPOINTS
// ============================================

// GET /api/admin/costs/anthropic - Uso de Claude API
app.get('/api/admin/costs/anthropic', authenticateAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // Defaults: último mes
    const now = new Date();
    const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const defaultEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const start = startDate ? new Date(startDate) : defaultStart;
    const end = endDate ? new Date(endDate) : defaultEnd;

    const apiKey = process.env.ANTHROPIC_ADMIN_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_ADMIN_API_KEY not configured' });
    }

    const url = new URL('https://api.anthropic.com/v1/organizations/usage_report/messages');
    url.searchParams.append('starting_at', start.toISOString());
    url.searchParams.append('ending_at', end.toISOString());
    url.searchParams.append('bucket_width', '1d');
    url.searchParams.append('group_by[]', 'model');

    const response = await axios.get(url.toString(), {
      headers: {
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey
      }
    });

    // Precios por millón de tokens (USD) - Claude 3.5 Haiku
    const pricing = {
      'claude-3-5-haiku-20241022': { input: 1.00, output: 5.00 },
      'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
      'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
      'default': { input: 1.00, output: 5.00 }
    };

    // Calcular costos desde los datos de uso
    const buckets = response.data?.data || [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;
    const byModel = {};

    buckets.forEach(bucket => {
      const model = bucket.model || 'default';
      const inputTokens = bucket.input_tokens || 0;
      const outputTokens = bucket.output_tokens || 0;

      const modelPricing = pricing[model] || pricing['default'];
      const inputCost = (inputTokens / 1000000) * modelPricing.input;
      const outputCost = (outputTokens / 1000000) * modelPricing.output;
      const bucketCost = inputCost + outputCost;

      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
      totalCost += bucketCost;

      if (!byModel[model]) {
        byModel[model] = { inputTokens: 0, outputTokens: 0, cost: 0 };
      }
      byModel[model].inputTokens += inputTokens;
      byModel[model].outputTokens += outputTokens;
      byModel[model].cost += bucketCost;
    });

    res.json({
      period: { start: start.toISOString().split('T')[0], end: end.toISOString().split('T')[0] },
      summary: {
        totalInputTokens,
        totalOutputTokens,
        totalCost: Math.round(totalCost * 100) / 100,
        byModel
      },
      rawBuckets: buckets.length
    });
  } catch (error) {
    console.error('⚠️ ADMIN: Anthropic costs error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error fetching Anthropic costs', details: error.response?.data });
  }
});

// GET /api/admin/costs/twilio - Uso de Twilio
app.get('/api/admin/costs/twilio', authenticateAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      return res.status(500).json({ error: 'Twilio credentials not configured' });
    }

    // Defaults: último mes
    const now = new Date();
    const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const defaultEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const start = startDate || defaultStart.toISOString().split('T')[0];
    const end = endDate || defaultEnd.toISOString().split('T')[0];

    // Consultar todas las categorías (sin filtro) para capturar WhatsApp y SMS
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Usage/Records.json?StartDate=${start}&EndDate=${end}`;

    const response = await axios.get(url, {
      auth: {
        username: accountSid,
        password: authToken
      }
    });

    // Filtrar categorías relevantes para mensajería
    const messagingCategories = [
      'sms', 'sms-inbound', 'sms-outbound',
      'mms', 'mms-inbound', 'mms-outbound',
      'conversations', 'conversations-user-initiated', 'conversations-business-initiated',
      'whatsapp', 'whatsapp-inbound', 'whatsapp-outbound'
    ];

    const records = response.data.usage_records || [];
    const summary = {
      totalCost: 0,
      totalMessages: 0,
      byCategory: {}
    };

    records.forEach(record => {
      // Solo incluir categorías de mensajería
      const category = record.category || '';
      const isMessaging = messagingCategories.some(cat =>
        category.toLowerCase().includes(cat.toLowerCase())
      );

      if (isMessaging) {
        const cost = parseFloat(record.price || 0);
        const count = parseInt(record.count || 0);
        summary.totalCost += cost;
        summary.totalMessages += count;

        if (!summary.byCategory[category]) {
          summary.byCategory[category] = { cost: 0, count: 0, description: record.description || '' };
        }
        summary.byCategory[category].cost += cost;
        summary.byCategory[category].count += count;
      }
    });

    res.json({
      period: { start, end },
      summary: {
        totalCost: Math.round(summary.totalCost * 100) / 100,
        totalMessages: summary.totalMessages,
        byCategory: summary.byCategory
      }
    });
  } catch (error) {
    console.error('⚠️ ADMIN: Twilio costs error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error fetching Twilio costs', details: error.response?.data });
  }
});

// GET /api/admin/costs/railway - Uso de Railway
app.get('/api/admin/costs/railway', authenticateAdmin, async (req, res) => {
  try {
    const railwayToken = process.env.RAILWAY_API_TOKEN;
    const projectId = process.env.RAILWAY_PROJECT_ID;

    if (!railwayToken || !projectId) {
      return res.status(500).json({ error: 'Railway credentials not configured' });
    }

    // Query para obtener info del proyecto y uso estimado de la cuenta
    const query = `
      query {
        project(id: "${projectId}") {
          name
          createdAt
          services {
            edges {
              node {
                name
                id
              }
            }
          }
        }
        me {
          name
          email
          customer {
            billingPeriodEnd
            usageLimit
            creditBalance
          }
          resourceAccess {
            project {
              projectId
            }
          }
        }
      }
    `;

    const response = await axios.post('https://backboard.railway.com/graphql/v2',
      { query },
      {
        headers: {
          'Authorization': `Bearer ${railwayToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = response.data.data;
    const customer = data?.me?.customer;

    res.json({
      project: data?.project,
      account: {
        name: data?.me?.name,
        email: data?.me?.email,
        billingPeriodEnd: customer?.billingPeriodEnd,
        usageLimit: customer?.usageLimit,
        creditBalance: customer?.creditBalance
      },
      note: 'Para costos detallados en tiempo real, revisar Railway Dashboard'
    });
  } catch (error) {
    console.error('⚠️ ADMIN: Railway costs error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error fetching Railway data', details: error.response?.data });
  }
});

// GET /api/admin/costs/summary - Resumen de todos los costos
app.get('/api/admin/costs/summary', authenticateAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // Hacer las 3 llamadas en paralelo
    const [anthropic, twilio, railway] = await Promise.allSettled([
      axios.get(`http://localhost:${process.env.PORT || 3000}/api/admin/costs/anthropic?startDate=${startDate || ''}&endDate=${endDate || ''}`, {
        headers: { 'Authorization': req.headers.authorization }
      }),
      axios.get(`http://localhost:${process.env.PORT || 3000}/api/admin/costs/twilio?startDate=${startDate || ''}&endDate=${endDate || ''}`, {
        headers: { 'Authorization': req.headers.authorization }
      }),
      axios.get(`http://localhost:${process.env.PORT || 3000}/api/admin/costs/railway`, {
        headers: { 'Authorization': req.headers.authorization }
      })
    ]);

    res.json({
      anthropic: anthropic.status === 'fulfilled' ? anthropic.value.data : { error: anthropic.reason?.message },
      twilio: twilio.status === 'fulfilled' ? twilio.value.data : { error: twilio.reason?.message },
      railway: railway.status === 'fulfilled' ? railway.value.data : { error: railway.reason?.message }
    });
  } catch (error) {
    console.error('⚠️ ADMIN: Costs summary error:', error);
    res.status(500).json({ error: 'Error fetching costs summary' });
  }
});

// Función principal para enviar recordatorios de gastos fijos
async function sendFixedExpenseReminders() {
  // Obtener fecha en zona horaria de Chile
  const now = new Date();
  const chileTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Santiago' }));
  const dayOfMonth = chileTime.getDate();
  const currentMonth = chileTime.toLocaleString('es-CL', { month: 'long' });

  console.log(`📅 Running fixed expense reminders for day ${dayOfMonth} (${currentMonth})`);

  // Buscar usuarios con gastos fijos para hoy
  const usersWithReminders = await getFixedExpensesForReminderDay(dayOfMonth);

  console.log(`👥 Found ${usersWithReminders.length} users with reminders for today`);

  let sentCount = 0;
  let errorCount = 0;

  for (const userReminder of usersWithReminders) {
    try {
      const { phone, name, expenses } = userReminder;
      const total = expenses.reduce((sum, e) => sum + parseFloat(e.amount), 0);

      // Formatear lista de gastos
      const expensesList = expenses.map(e => {
        const emoji = e.emoji || '💸';
        return `• ${emoji} ${e.description}: $${parseFloat(e.amount).toLocaleString('es-CL')}`;
      }).join('\n');

      // Mensaje de recordatorio
      const message =
        `Hola ${name || 'usuario'} 👋\n\n` +
        `Recordatorio de gastos fijos de ${currentMonth}:\n\n` +
        `${expensesList}\n\n` +
        `Total estimado: $${total.toLocaleString('es-CL')}\n\n` +
        `Responde:\n` +
        `"registrar todos" - Registrar todos los gastos\n` +
        `"ajustar montos" - Ajustar antes de registrar\n` +
        `"saltar mes" - No registrar este mes`;

      await sendWhatsApp(phone, message);

      // Guardar estado para procesar respuesta
      const userId = userReminder.user_id;
      await pool.query(
        `UPDATE users SET pending_fixed_expense_id = -999 WHERE id = $1`,
        [userId] // -999 indica que estamos esperando respuesta de recordatorio
      );

      console.log(`✅ Reminder sent to ${phone}`);
      sentCount++;
    } catch (error) {
      console.error(`❌ Error sending reminder to ${userReminder.phone}:`, error);
      errorCount++;
    }
  }

  return {
    day: dayOfMonth,
    month: currentMonth,
    usersNotified: sentCount,
    errors: errorCount
  };
}

// Endpoint para ejecutar recordatorios (llamado por cron externo)
app.post('/api/cron/send-reminders', authenticateCron, async (req, res) => {
  console.log('🔔 Cron job triggered: send-reminders');

  try {
    const result = await sendFixedExpenseReminders();
    console.log('✅ Cron job completed:', result);
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('❌ Cron error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint de test para verificar configuración (sin autenticación, solo para debug)
app.get('/api/cron/test', generalLimiter, async (req, res) => {
  const chileTime = new Date().toLocaleString('en-US', { timeZone: 'America/Santiago' });
  const dayOfMonth = new Date(chileTime).getDate();

  // Contar usuarios con recordatorios para hoy
  const countResult = await pool.query(
    `SELECT COUNT(DISTINCT user_id) as count
     FROM fixed_expenses
     WHERE reminder_day = $1 AND is_active = true`,
    [dayOfMonth]
  );

  res.json({
    status: 'ok',
    timezone: 'America/Santiago',
    currentTime: chileTime,
    dayOfMonth: dayOfMonth,
    usersWithRemindersToday: parseInt(countResult.rows[0].count)
  });
});

// Handler para respuestas a recordatorios de gastos fijos
async function handleFixedExpenseReminderResponse(user, message) {
  const msgLower = message.toLowerCase().trim();

  // Registrar todos
  if (msgLower.includes('registrar todos') || msgLower === 'registrar' || msgLower === 'todos') {
    const fixedExpenses = await getFixedExpenses(user.id, true);

    if (fixedExpenses.length === 0) {
      await clearPendingFixedExpense(user.id);
      await sendWhatsApp(user.phone, '🤔 No tienes gastos fijos activos para registrar.');
      return true;
    }

    // Registrar transacciones (evitando duplicados del mes actual)
    let total = 0;
    let registeredList = [];
    let skippedList = [];

    for (const expense of fixedExpenses) {
      // Verificar si ya existe una transacción de este gasto fijo en el mes actual
      const existingCheck = await pool.query(
        `SELECT id FROM transactions
         WHERE user_id = $1
           AND fixed_expense_id = $2
           AND date >= date_trunc('month', CURRENT_DATE)
         LIMIT 1`,
        [user.id, expense.id]
      );

      if (existingCheck.rows.length > 0) {
        // Ya existe, saltar
        const emoji = expense.category_emoji || '💸';
        skippedList.push(`• ${emoji} ${expense.description} (ya registrado)`);
        continue;
      }

      // No existe, registrar
      await pool.query(
        `INSERT INTO transactions (user_id, amount, category_id, description, date, is_income, expense_type, fixed_expense_id)
         VALUES ($1, $2, $3, $4, CURRENT_DATE, false, 'fixed', $5)`,
        [user.id, expense.typical_amount, expense.category_id, expense.description, expense.id]
      );
      total += parseFloat(expense.typical_amount);
      const emoji = expense.category_emoji || '💸';
      registeredList.push(`• ${emoji} ${expense.description}: $${parseFloat(expense.typical_amount).toLocaleString('es-CL')}`);
    }

    const currentMonth = new Date().toLocaleString('es-CL', { month: 'long' });
    await clearPendingFixedExpense(user.id);

    if (registeredList.length === 0 && skippedList.length > 0) {
      await sendWhatsApp(user.phone,
        `ℹ️ Todos tus gastos fijos ya estaban registrados este mes:\n${skippedList.join('\n')}`
      );
    } else if (registeredList.length > 0) {
      let reply = `✅ Registrados:\n${registeredList.join('\n')}\n\n` +
        `Total: $${total.toLocaleString('es-CL')} agregado a tus gastos de ${currentMonth}.`;

      if (skippedList.length > 0) {
        reply += `\n\n⚠️ Omitidos (ya registrados):\n${skippedList.join('\n')}`;
      }
      await sendWhatsApp(user.phone, reply);
    }
    return true;
  }

  // Ajustar montos
  if (msgLower.includes('ajustar') || msgLower.includes('modificar')) {
    await clearPendingFixedExpense(user.id);
    await sendWhatsApp(user.phone,
      'Ok, dime cuáles pagaste y el monto real:\n\n' +
      '(ej: "arriendo 450000, luz 52000")\n\n' +
      'O escribe "cancelar" para no registrar nada.'
    );
    return true;
  }

  // Saltar mes
  if (msgLower.includes('saltar') || msgLower.includes('skip') || msgLower === 'no') {
    await clearPendingFixedExpense(user.id);
    await sendWhatsApp(user.phone,
      '👍 Entendido, no registro nada.\n' +
      'Te recuerdo el próximo mes.'
    );
    return true;
  }

  return false; // No se procesó
}

// ============================================
// SERVER START
// ============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Ordenate Backend running on port ${PORT}`);
  console.log(`📱 Twilio webhook ready at /webhook`);
  console.log(`💾 Prompt caching enabled (90% cost savings)`);
});
