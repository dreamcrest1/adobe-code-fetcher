const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// All Dreamcrest domains now securely route through the Gmail bridge account
const ACCOUNTS_DB = {
  "as2006dream@dreamcrest.net": { bridgeUser: "azadhindorg@gmail.com", pass: "bxaa dvsi gluq owgz", host: "imap.gmail.com" },
  "ad2006adb@dreamcrest.net": { bridgeUser: "azadhindorg@gmail.com", pass: "bxaa dvsi gluq owgz", host: "imap.gmail.com" },
  "ax22@dreamcrest.net": { bridgeUser: "azadhindorg@gmail.com", pass: "bxaa dvsi gluq owgz", host: "imap.gmail.com" }
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

  // Connect to GMAIL using the bridge credentials
  const client = new ImapFlow({
    host: accountData.host,
    port: 993,
    secure: true,
    auth: { user: accountData.bridgeUser, pass: accountData.pass },
    logger: false,
    connectionTimeout: 15000,
    socketTimeout: 20000
  });

  client.on('error', () => {});

  try {
    await client.connect();

    async function fetchLatestFromFolder(folderPath) {
      try {
        const lock = await client.getMailboxLock(folderPath);
        try {
          // Because all 3 emails forward to the same Gmail, we search the folder 
          // specifically for emails containing the requested Dreamcrest address.
          const seqs = await client.search({ text: requestedEmail });
          
          if (seqs && seqs.length > 0) {
            // Get the maximum sequence number (the absolute most recent email)
            const latestSeq = Math.max(...seqs);
            const message = await client.fetchOne(`${latestSeq}`, { source: true });
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

    // 1. Fetch matching email from INBOX
    let latestInbox = await fetchLatestFromFolder('INBOX');

    // 2. Identify Spam folder (Gmail usually uses '[Gmail]/Spam')
    let spamFolderPath = null;
    const mailboxes = await client.list();
    for (let box of mailboxes) {
      if (box.flags.has('\\Junk') || box.name.toLowerCase().includes('spam')) {
        spamFolderPath = box.path;
        break;
      }
    }
    
    // 3. Fetch matching email from Spam
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
      return res.status(404).json({ 
        success: false, 
        message: `No emails found for ${requestedEmail} in the bridge Inbox or Spam.` 
      });
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
      return res.status(401).json({ success: false, message: `Gmail Bridge login failed. Check the App Password.` });
    }
    
    return res.status(502).json({ 
      success: false, 
      message: "Could not connect to Gmail.", 
      error: error.message || error.code
    });
  }
};
