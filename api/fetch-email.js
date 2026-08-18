const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// Map the frontend Outlook request to the backend Dreamcrest inbox
const ACCOUNTS_DB = {
  "as2006dream@outlook.com": { 
    backendEmail: "as2006dream@dreamcrest.net", 
    pass: "XGas1212$$@@", 
    host: "mail.dreamcrest.net", 
    type: "dreamcrest" 
  },
  "ad2006adb@outlook.com": { 
    backendEmail: "ad2006adb@dreamcrest.net", 
    pass: "XGas1212$$@@", 
    host: "mail.dreamcrest.net", 
    type: "dreamcrest" 
  },
  "azadhindorg@gmail.com": { 
    backendEmail: "azadhindorg@gmail.com", 
    pass: "bxaa dvsi gluq owgz", 
    host: "imap.gmail.com", 
    type: "gmail" 
  }
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
    auth: { user: accountData.backendEmail, pass: accountData.pass },
    logger: false,
    connectionTimeout: 15000,
    socketTimeout: 20000
  });

  client.on('error', () => {});

  try {
    await client.connect();

    // Helper function to safely fetch the newest email from a specific folder
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
        return null; // Folder doesn't exist or is inaccessible
      }
      return null;
    }

    // 1. Fetch from INBOX
    let latestInbox = await fetchLatestFromFolder('INBOX');

    // 2. Identify Spam/Junk folder dynamically
    let spamFolderPath = null;
    const mailboxes = await client.list();
    for (let box of mailboxes) {
      // Look for standard IMAP Junk flags or common names
      if (box.flags.has('\\Junk') || box.name.toLowerCase() === 'spam' || box.name.toLowerCase() === 'junk') {
        spamFolderPath = box.path;
        break;
      }
    }
    
    // 3. Fetch from Spam (if it exists)
    let latestSpam = spamFolderPath ? await fetchLatestFromFolder(spamFolderPath) : null;

    // 4. Compare dates to find the absolute latest email received
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

    // 5. Mask the backend email so the user only sees the Outlook email
    let toText = parsed.to?.text || requestedEmail;
    if (accountData.type === 'dreamcrest') {
      const regex = new RegExp(accountData.backendEmail, 'gi');
      toText = toText.replace(regex, requestedEmail);
    }

    const payload = {
      success: true,
      data: {
        email: requestedEmail,
        folder: location,
        subject: parsed.subject || "No Subject",
        from: parsed.from?.text || "Unknown Sender",
        to: toText,
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
      return res.status(401).json({ success: false, message: `Login failed for backend account. Check passwords.` });
    }
    return res.status(502).json({ success: false, message: "Could not connect to the mail server.", error: error.message });
  }
};
