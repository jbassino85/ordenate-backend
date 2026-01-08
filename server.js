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
    console.log(`🔄 Processing message from ${phone}: "${message}"`);
    
    // 1. Obtener o crear usuario
    let user = await getOrCreateUser(phone);
    console.log(`👤 User loaded: id=${user.id}, onboarding_complete=${user.onboarding_complete}, onboarding_step="${user.onboarding_step}"`);
    
    // 2. Si no completó onboarding
    if (!user.onboarding_complete) {
      
      // Si está en awaiting_income, enviar pregunta inicial
      console.log(`🔍 Checking: user.onboarding_step="${user.onboarding_step}" === "awaiting_income" ? ${user.onboarding_step === 'awaiting_income'}`);
      if (user.onboarding_step === 'awaiting_income') {
        await sendWhatsApp(phone,
          '👋 ¡Hola! Bienvenido a Ordénate!\n\n' +
          'Para brindarte un mejor servicio como tu asesor financiero, ' +
          'necesito conocer tu situación financiera.\n\n' +
          '💰 ¿Cuál es tu ingreso mensual aproximado?\n' +
          '(Puedes responder en miles, ej: "800 lucas" o "$800000")'
        );
        
        // Cambiar step para que próximo mensaje se procese como respuesta
        console.log(`🔄 Updating onboarding_step to awaiting_income_response...`);
        await pool.query(
          'UPDATE users SET onboarding_step = $1 WHERE id = $2',
          ['awaiting_income_response', user.id]
        );
        console.log(`✅ Step updated successfully`);
        return;
      }
      
      // Procesar respuesta de onboarding
      console.log(`🎓 Handling onboarding step: ${user.onboarding_step}`);
      await handleOnboarding(user, message);
      return;
    }
    
    console.log(`🤖 Classifying intent with Claude...`);
    
    // 3. Usuario completo - clasificar intención con Claude
    const intent = await classifyIntent(message, user);
    
    console.log(`🎯 Intent detected: ${intent.type}`);
    
    // 4. Ejecutar acción según intención
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
      case 'BUDGET_STATUS':
        await handleBudgetStatus(user, intent.data);
        break;
      case 'FINANCIAL_ADVICE':
        await handleFinancialAdvice(user, intent.data, message);
        break;
      default:
        await sendWhatsApp(phone, 
          '🤔 No entendí tu mensaje. Puedes decir:\n\n' +
          '💸 "Gasté $5000 en almuerzo"\n' +
          '📊 "¿Cuánto gasté esta semana?"\n' +
          '💰 "Quiero gastar máximo $100000 en comida"\n' +
          '💡 "¿Cómo puedo ahorrar más?"'
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
   
6. OTHER: Otro tipo

MODISMOS CHILENOS:
- "lucas/luca/lukas" = miles de pesos (ej: "5 lucas" = 5000)
- "gamba" = 100 pesos
- "palo" = millón
- "chaucha" = poco dinero

CATEGORÍAS DE GASTOS:
comida, transporte, entretenimiento, salud, servicios, compras, hogar, educacion, otros

REGLAS PARA EL CAMPO "description":
- Capitalizar primera letra del comercio/lugar
- NO incluir prefijos como "gasto en", "Gasto en", "compra en"
- Solo el nombre del lugar capitalizado
- Ejemplos correctos:
  * Input: "gasté en uber" → Output description: "Uber"
  * Input: "gaste 5000 en mcdonald's" → Output description: "McDonald's"
  * Input: "compre en walmart" → Output description: "Walmart"
  * Input: "almuerzo" → Output description: "Almuerzo"

FORMATO DE RESPUESTA:
Responde SOLO con JSON válido (sin markdown, sin explicaciones):
{
  "type": "TRANSACTION|QUERY|BUDGET|BUDGET_STATUS|FINANCIAL_ADVICE|OTHER",
  "data": {
    "amount": número_sin_símbolos,
    "category": "categoría",
    "description": "texto",
    "is_income": true/false,
    "period": "today|yesterday|week|month|year|last_week|last_month",
    "detail": true/false (solo para QUERY: true si pide desglose, false para resumen),
    "question": "pregunta_original" (solo para FINANCIAL_ADVICE)
  }
}

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
- "¿debería gastar en X?" → {"type":"FINANCIAL_ADVICE","data":{"question":"¿debería gastar en X?"}}`
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
    
    const jsonText = response.content[0].text.trim();
    const cleaned = jsonText.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (error) {
    console.error('❌ Claude error:', error);
    return { type: 'OTHER' };
  }
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
  
  // Buscar número seguido de "lucas", "luca", "mil", "k"
  let match = cleaned.match(/(\d+)\s*(lucas|luca|lukas|mil|k)/);
  if (match) {
    return parseInt(match[1]) * 1000;
  }
  
  // Buscar "palo" (millón)
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
  
  // Normalizar valores viejos
  let step = user.onboarding_step;
  if (step === 'responding_income') step = 'awaiting_income_response';
  
  switch(step) {
    case 'awaiting_income_response':
      if (!amount || amount < 50000) {
        await sendWhatsApp(user.phone, 
          '🤔 No detecté un monto válido.\n\n' +
          'Por favor indícame tu ingreso mensual.\n' +
          'Ej: "800000" o "800 lucas"'
        );
        return;
      }
      
      // Guardar ingreso y pasar a siguiente step
      await pool.query(
        'UPDATE users SET monthly_income = $1, onboarding_step = $2 WHERE id = $3',
        [amount, 'awaiting_savings_goal', user.id]
      );
      
      await sendWhatsApp(user.phone,
        `✅ Perfecto, ingreso mensual: $${amount.toLocaleString('es-CL')}\n\n` +
        '🎯 ¿Cuánto te gustaría ahorrar al mes?\n\n' +
        'Tip: Se recomienda ahorrar al menos el 10-20% de tus ingresos.\n' +
        `(En tu caso, entre $${(amount * 0.1).toLocaleString('es-CL')} y $${(amount * 0.2).toLocaleString('es-CL')})`
      );
      break;
      
    case 'awaiting_savings_goal':
      if (!amount || amount <= 0) {
        await sendWhatsApp(user.phone,
          '🤔 No detecté un monto válido.\n\n' +
          'Por favor indícame cuánto quieres ahorrar al mes.\n' +
          'Ej: "100000" o "100 lucas"'
        );
        return;
      }
      
      const income = parseFloat(user.monthly_income);
      
      // Validar que la meta de ahorro sea razonable
      if (amount > income * 0.8) {
        await sendWhatsApp(user.phone,
          `⚠️ Tu meta de ahorro ($${amount.toLocaleString('es-CL')}) es muy alta comparada con tu ingreso ($${income.toLocaleString('es-CL')}).\n\n` +
          'Te sugiero una meta más realista (máximo 80% del ingreso).\n\n' +
          '¿Cuál será tu meta de ahorro mensual?'
        );
        return;
      }
      
      // Guardar meta y completar onboarding
      await pool.query(
        'UPDATE users SET savings_goal = $1, onboarding_complete = true WHERE id = $2',
        [amount, user.id]
      );
      
      const spendingBudget = income - amount;
      
      await sendWhatsApp(user.phone,
        `🎉 ¡Perfecto! Tu perfil financiero está listo:\n\n` +
        `💰 Ingreso mensual: $${income.toLocaleString('es-CL')}\n` +
        `🎯 Meta de ahorro: $${amount.toLocaleString('es-CL')} (${((amount/income)*100).toFixed(0)}%)\n` +
        `💸 Presupuesto para gastos: $${spendingBudget.toLocaleString('es-CL')}\n\n` +
        `━━━━━━━━━━━━━\n\n` +
        `Ahora puedo ayudarte a:\n\n` +
        `📝 Registrar gastos:\n` +
        `"Gasté 5000 en almuerzo"\n\n` +
        `📊 Consultar gastos:\n` +
        `"¿Cuánto gasté esta semana?"\n\n` +
        `💰 Configurar presupuestos:\n` +
        `"Quiero gastar máximo 100000 en comida"\n\n` +
        `📈 Estado financiero:\n` +
        `"¿Cómo van mis presupuestos?"\n\n` +
        `¡Comienza registrando tu primer gasto! 🚀`
      );
      break;
  }
}

// ============================================
// ALERTAS INTELIGENTES
// ============================================

// Sistema de alertas inteligentes
async function checkFinancialHealth(user) {
  const income = parseFloat(user.monthly_income);
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
  
  // Calcular gastos del mes actual
  const spentResult = await pool.query(
    `SELECT 
       category,
       SUM(amount) as category_total
     FROM transactions 
     WHERE user_id = $1 
       AND date >= date_trunc('month', CURRENT_DATE)
       AND is_income = false
     GROUP BY category
     ORDER BY category_total DESC`,
    [user.id]
  );
  
  if (spentResult.rows.length === 0) {
    return; // No hay gastos aún
  }
  
  const totalSpent = spentResult.rows.reduce((sum, row) => sum + parseFloat(row.category_total), 0);
  const percentageUsed = (totalSpent / spendingBudget) * 100;
  
  // Calcular días transcurridos y proyección
  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projectedTotal = (totalSpent / dayOfMonth) * daysInMonth;
  const projectedSavings = income - projectedTotal;
  
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
    alertMessage = `⚠️ Alerta Financiera\n\n` +
      `Llevas gastado $${totalSpent.toLocaleString('es-CL')} este mes (${percentageUsed.toFixed(0)}% de tu presupuesto).\n\n` +
      `📊 Tu presupuesto disponible era: $${spendingBudget.toLocaleString('es-CL')}\n` +
      `💰 Te quedan: $${(spendingBudget - totalSpent).toLocaleString('es-CL')}\n\n` +
      `⚠️ Cuidado: A este ritmo, podrías no alcanzar tu meta de ahorro de $${savingsGoal.toLocaleString('es-CL')}.\n\n`;
  }
  
  // Alerta 2: Proyección indica que no alcanzará meta
  if (projectedSavings < savingsGoal * 0.8 && !shouldAlert) {
    shouldAlert = true;
    alertType = 'savings_risk';
    alertMessage = `🚨 Tu meta de ahorro está en riesgo\n\n` +
      `📈 Proyección fin de mes:\n` +
      `Gastos estimados: $${projectedTotal.toLocaleString('es-CL')}\n` +
      `Ahorro estimado: $${projectedSavings.toLocaleString('es-CL')}\n` +
      `Meta de ahorro: $${savingsGoal.toLocaleString('es-CL')}\n\n` +
      `💡 Necesitas reducir gastos en $${(projectedTotal - spendingBudget).toLocaleString('es-CL')} para alcanzar tu meta.\n\n`;
  }
  
  // Alerta 3: Categoría específica > 30% del ingreso
  if (topCategoryPercentage > 30 && !shouldAlert) {
    shouldAlert = true;
    alertType = 'category_high';
    alertMessage = `💡 Consejo Financiero\n\n` +
      `Noté que gastas mucho en ${topCategory.category}:\n` +
      `$${parseFloat(topCategory.category_total).toLocaleString('es-CL')} (${topCategoryPercentage.toFixed(0)}% de tu ingreso)\n\n` +
      `Se recomienda que ninguna categoría supere el 30% de tus ingresos.\n\n`;
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
  
  const prompt = `Eres un asesor financiero en Chile. Analiza esta situación y da un consejo específico y accionable (máximo 3 líneas):

Ingreso mensual: $${income.toLocaleString('es-CL')}
Meta de ahorro: $${savingsGoal.toLocaleString('es-CL')}
Presupuesto para gastos: $${spendingBudget.toLocaleString('es-CL')}
Gastado hasta ahora: $${totalSpent.toLocaleString('es-CL')}
Categoría más alta: ${topCategory} ($${topCategoryAmount.toLocaleString('es-CL')})

Da un consejo específico de cómo reducir gastos en ${topCategory} o ajustar hábitos. Sé directo y práctico.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: prompt
      }]
    });
    
    return `💡 Consejo:\n${response.content[0].text}`;
  } catch (error) {
    console.error('❌ Error generating advice:', error);
    return `💡 Consejo:\nTrata de reducir gastos en ${topCategory} esta semana para volver al presupuesto.`;
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
  
  // Verificar alertas de presupuesto
  if (category) {
    await checkBudgetAlerts(user, category);
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
}

async function handleQuery(user, data) {
  const { period, category, detail } = data;
  
  let dateFilter = 'date >= CURRENT_DATE';
  let periodText = 'hoy';
  
  switch(period) {
    case 'today':
      dateFilter = 'date = CURRENT_DATE';
      periodText = 'hoy';
      break;
    case 'yesterday':
      dateFilter = 'date = CURRENT_DATE - INTERVAL \'1 day\'';
      periodText = 'ayer';
      break;
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
    case 'last_week':
      dateFilter = "date >= date_trunc('week', CURRENT_DATE - INTERVAL '1 week') AND date < date_trunc('week', CURRENT_DATE)";
      periodText = 'la semana pasada';
      break;
    case 'last_month':
      dateFilter = "date >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month') AND date < date_trunc('month', CURRENT_DATE)";
      periodText = 'el mes pasado';
      break;
  }
  
  // Si pide detalle, mostrar transacciones individuales
  if (detail) {
    let query = `
      SELECT category, description, amount, date, is_income
      FROM transactions
      WHERE user_id = $1 AND ${dateFilter}
    `;
    
    if (category) {
      query += ` AND category = $2`;
    }
    
    query += ' ORDER BY category, date DESC';
    
    const result = await pool.query(
      query,
      category ? [user.id, category] : [user.id]
    );
    
    if (result.rows.length === 0) {
      const catText = category ? ` en ${category}` : '';
      await sendWhatsApp(user.phone, `No tienes gastos registrados${catText} ${periodText} 📊`);
      return;
    }
    
    // Agrupar por categoría
    const byCategory = {};
    let totalExpenses = 0;
    let totalIncome = 0;
    
    result.rows.forEach(row => {
      if (!byCategory[row.category]) {
        byCategory[row.category] = [];
      }
      byCategory[row.category].push(row);
      
      if (row.is_income) {
        totalIncome += parseFloat(row.amount);
      } else {
        totalExpenses += parseFloat(row.amount);
      }
    });
    
    // Emojis por categoría
    const categoryEmojis = {
      comida: '🍕',
      transporte: '🚗',
      entretenimiento: '🎬',
      salud: '⚕️',
      servicios: '🔧',
      compras: '🛍️',
      hogar: '🏠',
      educacion: '📚',
      otros: '📦'
    };
    
    const catText = category ? ` - ${category.charAt(0).toUpperCase() + category.slice(1)}` : '';
    let reply = `📊 Detalle ${periodText}${catText}:\n\n`;
    
    // Mostrar cada categoría con sus transacciones
    Object.keys(byCategory).sort().forEach(cat => {
      const emoji = categoryEmojis[cat] || '💸';
      const catTotal = byCategory[cat].reduce((sum, t) => sum + parseFloat(t.amount), 0);
      
      reply += `${emoji} ${cat.charAt(0).toUpperCase() + cat.slice(1)}:\n`;
      
      byCategory[cat].forEach(transaction => {
        const date = new Date(transaction.date);
        const dateStr = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
        reply += `  • ${transaction.description || 'Sin descripción'}: $${Number(transaction.amount).toLocaleString('es-CL')} (${dateStr})\n`;
      });
      
      reply += `  Total: $${catTotal.toLocaleString('es-CL')}\n\n`;
    });
    
    reply += `━━━━━━━━━━━━━\n`;
    reply += `Total gastado: $${totalExpenses.toLocaleString('es-CL')}`;
    
    if (totalIncome > 0) {
      reply += `\nTotal ingresos: $${totalIncome.toLocaleString('es-CL')}`;
      reply += `\nBalance: $${(totalIncome - totalExpenses).toLocaleString('es-CL')}`;
    }
    
    await sendWhatsApp(user.phone, reply);
    return;
  }
  
  // Modo resumen (agregado por categoría) - código existente
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
    const catText = category ? ` en ${category}` : '';
    await sendWhatsApp(user.phone, `No tienes gastos registrados${catText} ${periodText} 📊`);
    return;
  }
  
  const catText = category ? ` - ${category.charAt(0).toUpperCase() + category.slice(1)}` : '';
  let reply = `📊 Resumen ${periodText}${catText}:\n\n`;
  
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
  
  // NOTA: Este mensaje de upgrade solo se muestra en queries (consultas de gastos)
  // TODO: Personalizar mensaje según contexto cuando hagamos split free/premium
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

async function handleBudgetStatus(user, data) {
  // Obtener todos los presupuestos del usuario
  const budgetsResult = await pool.query(
    `SELECT category, monthly_limit FROM budgets WHERE user_id = $1 ORDER BY category`,
    [user.id]
  );
  
  if (budgetsResult.rows.length === 0) {
    await sendWhatsApp(user.phone, 
      '📊 No tienes presupuestos configurados todavía.\n\nPuedes crear uno diciendo:\n"Quiero gastar máximo $100000 en comida"'
    );
    return;
  }
  
  // Emojis por categoría
  const categoryEmojis = {
    comida: '🍕',
    transporte: '🚗',
    entretenimiento: '🎬',
    salud: '⚕️',
    servicios: '🔧',
    compras: '🛍️',
    hogar: '🏠',
    educacion: '📚',
    otros: '📦'
  };
  
  // Obtener mes actual para el título
  const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 
                  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const currentMonth = months[new Date().getMonth()];
  
  let reply = `💰 Estado de tus presupuestos (${currentMonth}):\n\n`;
  let totalBudget = 0;
  let totalSpent = 0;
  
  // Para cada presupuesto, calcular gasto del mes
  for (const budget of budgetsResult.rows) {
    const limit = parseFloat(budget.monthly_limit);
    totalBudget += limit;
    
    // Calcular gasto del mes actual en esta categoría
    const spentResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM transactions 
       WHERE user_id = $1 AND category = $2 
       AND date >= date_trunc('month', CURRENT_DATE)
       AND is_income = false`,
      [user.id, budget.category]
    );
    
    const spent = parseFloat(spentResult.rows[0].total);
    totalSpent += spent;
    
    const percentage = (spent / limit) * 100;
    const available = limit - spent;
    
    const emoji = categoryEmojis[budget.category] || '📦';
    const catName = budget.category.charAt(0).toUpperCase() + budget.category.slice(1);
    
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
       category,
       SUM(amount) as total
     FROM transactions 
     WHERE user_id = $1 
       AND date >= date_trunc('month', CURRENT_DATE)
       AND is_income = false
     GROUP BY category
     ORDER BY total DESC`,
    [user.id]
  );
  
  const totalSpent = spentResult.rows.reduce((sum, row) => sum + parseFloat(row.total), 0);
  
  // Obtener presupuestos configurados
  const budgetsResult = await pool.query(
    `SELECT category, monthly_limit FROM budgets WHERE user_id = $1`,
    [user.id]
  );
  
  // Calcular proyección
  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projectedTotal = totalSpent > 0 ? (totalSpent / dayOfMonth) * daysInMonth : 0;
  const projectedSavings = income - projectedTotal;
  
  // Construir contexto para Claude
  let context = `Eres un asesor financiero en Chile. El usuario te pregunta: "${originalQuestion}"\n\n`;
  context += `CONTEXTO FINANCIERO DEL USUARIO:\n`;
  context += `- Ingreso mensual: $${income.toLocaleString('es-CL')}\n`;
  context += `- Meta de ahorro: $${savingsGoal.toLocaleString('es-CL')} (${((savingsGoal/income)*100).toFixed(0)}% del ingreso)\n`;
  context += `- Presupuesto disponible para gastos: $${spendingBudget.toLocaleString('es-CL')}\n\n`;
  
  context += `SITUACIÓN ACTUAL (este mes):\n`;
  context += `- Día ${dayOfMonth} de ${daysInMonth} del mes\n`;
  context += `- Gastado hasta ahora: $${totalSpent.toLocaleString('es-CL')} (${((totalSpent/spendingBudget)*100).toFixed(0)}% del presupuesto)\n`;
  context += `- Disponible: $${(spendingBudget - totalSpent).toLocaleString('es-CL')}\n`;
  context += `- Proyección fin de mes: $${projectedTotal.toLocaleString('es-CL')} en gastos, $${projectedSavings.toLocaleString('es-CL')} de ahorro\n\n`;
  
  if (spentResult.rows.length > 0) {
    context += `GASTOS POR CATEGORÍA:\n`;
    spentResult.rows.forEach(row => {
      const percentage = (parseFloat(row.total) / income) * 100;
      context += `- ${row.category}: $${parseFloat(row.total).toLocaleString('es-CL')} (${percentage.toFixed(1)}% del ingreso)\n`;
    });
    context += `\n`;
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
  context += `5. Usa máximo 5-6 líneas\n`;
  context += `6. Usa emojis relevantes pero no abuses`;
  
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{
        role: "user",
        content: context
      }]
    });
    
    await sendWhatsApp(user.phone, `💡 ${response.content[0].text}`);
  } catch (error) {
    console.error('❌ Error generating financial advice:', error);
    await sendWhatsApp(user.phone, 
      'Ups, tuve un problema generando el consejo. ¿Puedes intentar reformular tu pregunta? 🤔'
    );
  }
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
    // Usuario nuevo
    result = await pool.query(
      'INSERT INTO users (phone, onboarding_complete, onboarding_step) VALUES ($1, false, $2) RETURNING *',
      [phone, 'awaiting_income']
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
