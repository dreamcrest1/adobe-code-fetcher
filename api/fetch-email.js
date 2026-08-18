const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const ACCOUNTS_DB = {
  "as2006dream@outlook.com": { pass: "ywzpxgovoidvkstq", type: "outlook" },
  "ad2006adb@outlook.com": { pass: "elbnyzascccifgjn", type: "outlook" },
  "azadhindorg@gmail.com": { pass: "bxaa dvsi gluq owgz", type: "gmail" }
};

const PROVIDERS = {
  gmail: { host: "imap.gmail.com", port: 993, secure: true },
  outlook: { host: "outlook.office365.com", port: 993, secure: true }
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

  const { email } = req.body || {};
  const normalizedEmail = (email || "").toLowerCase().trim();

  if (!normalizedEmail || !ACCOUNTS_DB[normalizedEmail]) {
    return res.status(400).json({ 
      success: false, 
      message: "Selected email ID is not configured in the system." 
    });
  }

  const accountData = ACCOUNTS_DB[normalizedEmail];
  const providerConfig = PROVIDERS[accountData.type];

  if (!providerConfig) {
      return res.status(500).json({ success: false, message: "Invalid email provider configured." });
  }

  const client = new ImapFlow({
    host: providerConfig.host,
    port: providerConfig.port,
    secure: providerConfig.secure,
    auth: { user: normalizedEmail, pass: accountData.pass },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000
  });

  client.on('error', () => {});

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    let payload;
    try {
      const status = await client.status('INBOX', { messages: true });
      if (status.messages === 0) {
        payload = { statusCode: 404, body: { success: false, message: "Inbox is empty." } };
      } else {
        const message = await client.fetchOne(`${status.messages}`, { source: true, envelope: true });
        const parsed = await simpleParser(message.source);

        payload = {
          statusCode: 200,
          body: {
            success: true,
            data: {
              email: normalizedEmail,
              subject: parsed.subject || "No Subject",
              from: parsed.from?.text || "Unknown Sender",
              to: parsed.to?.text || normalizedEmail,
              date: parsed.date || new Date(),
              html: parsed.html || null,
              text: parsed.text || "",
              snippet: parsed.text ? parsed.text.substring(0, 200).replace(/\s+/g, ' ').trim() : ""
            }
          }
        };
      }
    } finally {
      lock.release();
    }

    await client.logout();
    return res.status(payload.statusCode).json(payload.body);
  } catch (error) {
    try { await client.logout(); } catch (_) {}

    if (error.authenticationFailed) {
      return res.status(401).json({
        success: false,
        message: `Login failed for ${normalizedEmail}. Check your App Password.`,
        error: error.responseText || "Authentication failed."
      });
    }

    if (error.code === 'ETIMEOUT' || error.code === 'ETIMEDOUT' || /timeout/i.test(error.message || "")) {
      return res.status(504).json({
        success: false,
        message: "Mail server timed out.",
        error: error.message
      });
    }

    return res.status(502).json({
      success: false,
      message: "Connection error.",
      error: error.responseText || error.message
    });
  }
};
