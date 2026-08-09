const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const P = require('pino');
const http = require('http');

const PORT = process.env.PORT || 3000;
const PHONE_NUMBER = process.env.PHONE_NUMBER;

http.createServer((req, res) => {
  res.writeHead(200);
  res.end('BerylsBot is running 🤖');
}).listen(PORT);

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState('./session');

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'connecting') {
      console.log('Connecting to WhatsApp...');
    }

    if (connection === 'open') {
      console.log('✅ BerylsBot connected!');

      if (PHONE_NUMBER && !state.creds.registered) {
        try {
          const code = await sock.requestPairingCode(
            PHONE_NUMBER.replace(/\D/g, '')
          );

          console.log('PAIRING CODE:', code);
        } catch (error) {
          console.error('Pairing code error:', error);
        }
      }
    }

    if (connection === 'close') {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      if (statusCode !== DisconnectReason.loggedOut) {
        console.log('Connection closed. Reconnecting...');
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

    const chat = msg.key.remoteJid;

    if (text === '.ping') {
      await sock.sendMessage(chat, {
        text: '🏓 BerylsBot is online!'
      });
    }

    if (text === '.menu') {
      await sock.sendMessage(chat, {
        text: `🤖 BERYLSBOT

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

startBot().catch(console.error);
