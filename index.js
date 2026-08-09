const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const P = require('pino');
const readline = require('readline');

const PHONE_NUMBER = process.env.PHONE_NUMBER;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./session');

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  if (!sock.authState?.creds?.registered && PHONE_NUMBER) {
    try {
      const code = await sock.requestPairingCode(PHONE_NUMBER);
      console.log('YOUR PAIRING CODE:', code);
    } catch (error) {
      console.error('Pairing code error:', error);
    }
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log('BerylsBot is connected! 🤖');
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      console.log('Connection closed.');

      if (shouldReconnect) {
        startBot();
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];

    if (!msg?.message || msg.key.fromMe) return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

    if (text === '.ping') {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '🏓 BerylsBot is online!'
      });
    }

    if (text === '.menu') {
      await sock.sendMessage(msg.key.remoteJid, {
        text:
`🤖 BERYLSBOT MENU

.ping
.menu
.tagall
.ban
.vv
.sticker
.ai

🎵 Music
🎮 Games
👋 Welcome messages
🛡️ Group protection`
      });
    }
  });
}

startBot();
