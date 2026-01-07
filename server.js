require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ============================================
// CONFIGURACIÓN DE SERVICIOS
// ============================================

// PostgreSQL Connection (Railway)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
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

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'Ordenate Backend',
    timestamp: new Date().toISOString()
  });
});

// Twilio webhook (recibir mensajes)
app.post('/webhook', async (req, res) => {
  try {
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

async function processUserMessage(phone, message) {
  try {
    // 1. Obtener o crear usuario
    let user = await getOrCreateUser(phone);
    
    // 2. Clasificar intención con Claude
    const intent = await classifyIntent(message, user);
    
    // 3. Ejecutar acción según intención
    switch(intent.type) {
      case 'TRANSACTION':
        await handleTransaction(user, intent.data);
        break;
      case 'QUERY':
        await handleQuery(user, intent.data);
        break;
      case 'BUDGET':
        await handleBudget(user, intent.data);
        break;
      default:
        await sendWhatsApp(phone, '🤔 No entendí tu mensaje. Puedes decir:\n\n💸 "Gasté $5000 en almuerzo"\n📊 "¿Cuánto gasté esta semana?"\n💰 "Quiero gastar máximo $100000 en comida"');
    }
  } catch (error) {
    console.error('❌ Process error:', error);
    await sendWhatsApp(phone, 'Ups, tuve un problema. ¿Puedes intentar de nuevo? 🔧');
  }
}

// ============================================
// CLASIFICACIÓN CON CLAUDE (CON PROMPT CACHING)
// ============================================

async function classifyIntent(message, user) {
  // System instructions (CACHED - Se reutilizan entre llamadas)
  const systemInstructions = [
    {
      type: "text",
      text: `Eres un asistente de finanzas personal en Chile. Analiza mensajes de usuarios y clasifica su intención.

CATEGORÍAS POSIBLES:
1. TRANSACTION: Registrar gasto/ingreso
   Ejemplos: "gasté 5 lucas en almuerzo", "ingresé 50 mil por freelance"
   
2. QUERY: Consultar información
   Ejemplos: "¿cuánto gasté esta semana?", "mostrar mis gastos"
   
3. BUDGET: Configurar presupuesto
   Ejemplos: "quiero gastar máximo 100 lucas en comida", "mi presupuesto de transporte es 50 mil"
   
4. OTHER: Otro tipo

MODISMOS CHILENOS:
- "lucas/luca/lukas" = miles de pesos (ej: "5 lucas" = 5000)
- "gamba" = 100 pesos
- "palo" = millón
- "chaucha" = poco dinero

CATEGORÍAS DE GASTOS:
comida, transporte, entretenimiento, salud, servicios, compras, hogar, educacion, otros

FORMATO DE RESPUESTA:
Responde SOLO con JSON válido (sin markdown, sin explicaciones):
{
  "type": "TRANSACTION|QUERY|BUDGET|OTHER",
  "data": {
    "amount": número_sin_símbolos,
    "category": "categoría",
    "description": "texto",
    "is_income": true/false,
    "period": "today|week|month|year"
  }
}`
    },
    {
      type: "text",
      text: "Analiza el siguiente mensaje del usuario y responde con el JSON de clasificación:",
      cache_control: { type: "ephemeral" }
    }
  ];

  try {
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
    const usage = response.usage;
    if (usage.cache_creation_input_tokens) {
      console.log(`💾 Cache created: ${usage.cache_creation_input_tokens} tokens`);
    }
    if (usage.cache_read_input_tokens) {
      console.log(`⚡ Cache hit: ${usage.cache_read_input_tokens} tokens (saved ~$${(usage.cache_read_input_tokens * 0.0000009).toFixed(4)})`);
    }
    
    const jsonText = response.content[0].text.trim();
    const cleaned = jsonText.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (error) {
    console.error('❌ Claude error:', error);
    return { type: 'OTHER' };
  }
}

// ============================================
// HANDLERS
// ============================================

async function handleTransaction(user, data) {
  const { amount, category, description, is_income } = data;
  
  // Insertar transacción
  await pool.query(
    `INSERT INTO transactions (user_id, amount, category, description, date, is_income)
     VALUES ($1, $2, $3, $4, CURRENT_DATE, $5)`,
    [user.id, amount, category || 'otros', description || '', is_income || false]
  );
  
  const emoji = is_income ? '💰' : '💸';
  let reply = `${emoji} ${is_income ? 'Ingreso' : 'Gasto'} registrado!\n\n`;
  reply += `💵 $${Number(amount).toLocaleString('es-CL')}\n`;
  reply += `📂 ${(category || 'otros').charAt(0).toUpperCase() + (category || 'otros').slice(1)}\n`;
  if (description) reply += `📝 ${description}\n`;
  
  await sendWhatsApp(user.phone, reply);
  
  // Verificar alertas premium
  if (user.plan === 'premium' && category) {
    await checkBudgetAlerts(user, category);
  }
}

async function handleQuery(user, data) {
  const { period, category } = data;
  
  let dateFilter = 'date >= CURRENT_DATE';
  let periodText = 'hoy';
  
  switch(period) {
    case 'week':
      dateFilter = "date >= date_trunc('week', CURRENT_DATE)";
      periodText = 'esta semana';
      break;
    case 'month':
      dateFilter = "date >= date_trunc('month', CURRENT_DATE)";
      periodText = 'este mes';
      break;
    case 'year':
      dateFilter = "date >= date_trunc('year', CURRENT_DATE)";
      periodText = 'este año';
      break;
  }
  
  let query = `
    SELECT 
      category,
      SUM(CASE WHEN is_income = false THEN amount ELSE 0 END) as expenses,
      SUM(CASE WHEN is_income = true THEN amount ELSE 0 END) as income
    FROM transactions
    WHERE user_id = $1 AND ${dateFilter}
  `;
  
  if (category) {
    query += ` AND category = $2`;
  }
  
  query += ' GROUP BY category ORDER BY expenses DESC';
  
  const result = await pool.query(
    query,
    category ? [user.id, category] : [user.id]
  );
  
  if (result.rows.length === 0) {
    await sendWhatsApp(user.phone, `No tienes gastos registrados ${periodText} 📊`);
    return;
  }
  
  let reply = `📊 Resumen ${periodText}:\n\n`;
  
  let totalExpenses = 0;
  let totalIncome = 0;
  
  result.rows.forEach(row => {
    const expenses = parseFloat(row.expenses);
    const income = parseFloat(row.income);
    totalExpenses += expenses;
    totalIncome += income;
    
    if (expenses > 0) {
      reply += `💸 ${row.category}: $${expenses.toLocaleString('es-CL')}\n`;
    }
  });
  
  reply += `\n━━━━━━━━━━━━━\n`;
  reply += `Total gastado: $${totalExpenses.toLocaleString('es-CL')}\n`;
  
  if (totalIncome > 0) {
    reply += `Total ingresos: $${totalIncome.toLocaleString('es-CL')}\n`;
    reply += `Balance: $${(totalIncome - totalExpenses).toLocaleString('es-CL')}`;
  }
  
  await sendWhatsApp(user.phone, reply);
  
  // Sugerir upgrade si es free
  if (user.plan === 'free') {
    setTimeout(async () => {
      await sendWhatsApp(user.phone, 
        '💎 ¿Quieres ver gráficos y análisis detallados?\n\nUpgrade a Premium por $10/mes\nEscribe "premium" para más info'
      );
    }, 2000);
  }
}

async function handleBudget(user, data) {
  const { category, amount } = data;
  
  if (!category || !amount) {
    await sendWhatsApp(user.phone, 'Necesito la categoría y el monto. Ej: "Quiero gastar máximo $100000 en comida"');
    return;
  }
  
  // Upsert presupuesto
  await pool.query(
    `INSERT INTO budgets (user_id, category, monthly_limit)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, category) 
     DO UPDATE SET monthly_limit = $3`,
    [user.id, category, amount]
  );
  
  await sendWhatsApp(user.phone,
    `✅ Presupuesto configurado:\n\n📂 ${category}\n💰 $${Number(amount).toLocaleString('es-CL')} al mes\n\nTe avisaré cuando llegues al 80% y 100%`
  );
}

async function checkBudgetAlerts(user, category) {
  // Obtener presupuesto
  const budgetResult = await pool.query(
    `SELECT monthly_limit FROM budgets WHERE user_id = $1 AND category = $2`,
    [user.id, category]
  );
  
  if (budgetResult.rows.length === 0) return;
  
  const budget = parseFloat(budgetResult.rows[0].monthly_limit);
  
  // Calcular gasto del mes
  const spentResult = await pool.query(
    `SELECT SUM(amount) as total FROM transactions 
     WHERE user_id = $1 AND category = $2 
     AND date >= date_trunc('month', CURRENT_DATE)
     AND is_income = false`,
    [user.id, category]
  );
  
  const spent = parseFloat(spentResult.rows[0].total || 0);
  const percentage = (spent / budget) * 100;
  
  if (percentage >= 100) {
    await sendWhatsApp(user.phone, 
      `🚨 ¡Alerta! Superaste tu presupuesto de ${category}:\n\nGastado: $${spent.toLocaleString('es-CL')}\nPresupuesto: $${budget.toLocaleString('es-CL')}`
    );
  } else if (percentage >= 80) {
    await sendWhatsApp(user.phone,
      `⚠️ Atención: Llevas ${percentage.toFixed(0)}% de tu presupuesto en ${category}`
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
    result = await pool.query(
      'INSERT INTO users (phone) VALUES ($1) RETURNING *',
      [phone]
    );
    
    // Mensaje de bienvenida
    await sendWhatsApp(phone,
      '👋 ¡Bienvenido a Ordenate!\n\n' +
      'Soy tu asistente de finanzas personales.\n\n' +
      'Puedes:\n' +
      '💸 Registrar gastos: "gasté 5 lucas en almuerzo"\n' +
      '💰 Registrar ingresos: "ingresé 50 mil por freelance"\n' +
      '📊 Consultar: "¿cuánto gasté esta semana?"\n\n' +
      '¡Comienza registrando tu primer gasto!'
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
// SERVER START
// ============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Ordenate Backend running on port ${PORT}`);
  console.log(`📱 Twilio webhook ready at /webhook`);
  console.log(`💾 Prompt caching enabled (90% cost savings)`);
});
