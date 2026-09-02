const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// Direct accounts database
const ACCOUNTS_DB = {
  "as2006dream@dreamcrest.net": { pass: "XGas1212$$@@", host: "mail.dreamcrest.net" },
  "ad2006adb@dreamcrest.net": { pass: "XGas1212$$@@", host: "mail.dreamcrest.net" },
  "ax22@dreamcrest.net": { pass: "XGas1212$$@@", host: "mail.dreamcrest.net" }
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

  const { email } = req.body || {};
  const requestedEmail = (email || "").toLowerCase().trim();

  if (!requestedEmail || !ACCOUNTS_DB[requestedEmail]) {
    return res.status(400).json({ success: false, message: "Selected email ID is not configured." });
  }

  const accountData = ACCOUNTS_DB[requestedEmail];

  const client = new ImapFlow({
    host: accountData.host,
    port: 993,
    secure: true,
    auth: { user: requestedEmail, pass: accountData.pass },
    logger: false,
    // INCREASED TIMEOUTS FOR CLOUD HOSTING
    connectionTimeout: 30000, 
    socketTimeout: 40000,
    tls: {
      rejectUnauthorized: false,
      minVersion: 'TLSv1' // Forces compatibility with older mail servers
    }
  });

  client.on('error', () => {});

  try {
    await client.connect();

    async function fetchLatestFromFolder(folderPath) {
      try {
        const lock = await client.getMailboxLock(folderPath);
        try {
          const status = await client.status(folderPath, { messages: true });
          if (status.messages > 0) {
            const message = await client.fetchOne(`${status.messages}`, { source: true, envelope: true });
            return await simpleParser(message.source);
          }
        } finally {
          lock.release();
        }
      } catch (err) {
        return null; 
      }
      return null;
    }

    let latestInbox = await fetchLatestFromFolder('INBOX');

    let spamFolderPath = null;
    const mailboxes = await client.list();
    for (let box of mailboxes) {
      if (box.flags.has('\\Junk') || box.name.toLowerCase() === 'spam' || box.name.toLowerCase() === 'junk') {
        spamFolderPath = box.path;
        break;
      }
    }
    
    let latestSpam = spamFolderPath ? await fetchLatestFromFolder(spamFolderPath) : null;

    let parsed = null;
    let location = 'INBOX';

    if (latestInbox && latestSpam) {
      if (new Date(latestSpam.date) > new Date(latestInbox.date)) {
        parsed = latestSpam;
        location = 'SPAM';
      } else {
        parsed = latestInbox;
      }
    } else if (latestInbox) {
      parsed = latestInbox;
    } else if (latestSpam) {
      parsed = latestSpam;
      location = 'SPAM';
    }

    if (!parsed) {
      await client.logout();
      return res.status(404).json({ success: false, message: "Both Inbox and Spam are completely empty." });
    }

    const payload = {
      success: true,
      data: {
        email: requestedEmail,
        folder: location,
        subject: parsed.subject || "No Subject",
        from: parsed.from?.text || "Unknown Sender",
        to: parsed.to?.text || requestedEmail,
        date: parsed.date || new Date(),
        html: parsed.html || null,
        text: parsed.text || ""
      }
    };

    await client.logout();
    return res.status(200).json(payload);

  } catch (error) {
    try { await client.logout(); } catch (_) {}

    if (error.authenticationFailed) {
      return res.status(401).json({ success: false, message: `Login failed. Check your password.` });
    }
    
    // THIS WILL CAPTURE THE EXACT SYSTEM ERROR
    const exactError = error.code || error.message || "Unknown Network Error";
    
    return res.status(502).json({ 
      success: false, 
      message: `Connection Blocked by Server: ${exactError}`, 
      error: exactError
    });
  }
};
