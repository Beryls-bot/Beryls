const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const P = require('pino');
const http = require('http');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const PHONE_NUMBER = process.env.PHONE_NUMBER;

const settingsFile = './settings.json';

let settings = {};
if (fs.existsSync(settingsFile)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile));
  } catch {
    settings = {};
  }
}

function saveSettings() {
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

function getGroupSettings(jid) {
  if (!settings[jid]) {
    settings[jid] = {
      antilink: false,
      autodelete: false,
      welcome: true,
      muted: []
    };
  }

  return settings[jid];
}

function isGroup(jid) {
  return jid.endsWith('@g.us');
}

async function getAdmins(sock, jid) {
  const metadata = await sock.groupMetadata(jid);

  return metadata.participants
    .filter(p => p.admin)
    .map(p => p.id);
}

async function isAdmin(sock, jid, user) {
  if (!isGroup(jid)) return false;

  const admins = await getAdmins(sock, jid);
  return admins.includes(user);
}

let reconnecting = false;

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState('./session');

  let version;

  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;

    console.log(
      `📱 WhatsApp Web version: ${version.join('.')}`
    );
  } catch (error) {
    console.log(
      '⚠️ Could not fetch latest WhatsApp Web version. Using Baileys default.'
    );
    console.error(error.message);
  }

  const sock = makeWASocket({
  auth: state,
  ...(version ? { version } : {}),
  logger: P({ level: 'silent' }),
  printQRInTerminal: false,
  markOnlineOnConnect: false,
  browser: ['BerylsBot', 'Chrome', '1.0.0']
});

  sock.ev.on('creds.update', saveCreds);

  /*
  ============================
  PAIRING CODE
  ============================
  */

if (PHONE_NUMBER && !state.creds.registered) {
  let pairingRequested = false;

  sock.ev.on('connection.update', async (update) => {
    const { qr } = update;

    if (qr && !pairingRequested) {
      pairingRequested = true;

      try {
        const number = PHONE_NUMBER.replace(/\D/g, '');

        console.log('📱 Requesting WhatsApp pairing code...');

        const code = await sock.requestPairingCode(number);

        console.log('================================');
        console.log('🤖 BERYLSBOT PAIRING CODE:', code);
        console.log('================================');
      } catch (error) {
        pairingRequested = false;

        console.error(
          '❌ Pairing code error:',
          error.message
        );
      }
    }
  });
}

  /*
  ============================
  CONNECTION
  ============================
  */

  sock.ev.on('connection.update', async (update) => {
    const {
      connection,
      lastDisconnect
    } = update;

    if (connection === 'connecting') {
      console.log('🔄 Connecting to WhatsApp...');
    }

    if (connection === 'open') {
      reconnecting = false;
      console.log('✅ BerylsBot connected to WhatsApp!');
    }

    if (connection === 'close') {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      console.log(
        '❌ Connection closed:',
        statusCode || 'unknown'
      );

      if (
        statusCode === DisconnectReason.loggedOut
      ) {
        console.log(
          '🚪 WhatsApp session logged out. Please pair again.'
        );
        return;
      }

      if (!reconnecting) {
        reconnecting = true;

        console.log(
          '🔄 Reconnecting in 5 seconds...'
        );

        setTimeout(() => {
          reconnecting = false;
          startBot().catch(console.error);
        }, 5000);
      }
    }
  });

  /*
  ============================
  MESSAGE HANDLER
  ============================
  */

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages[0];

      if (!msg?.message || msg.key.fromMe) return;

      const chat = msg.key.remoteJid;
      const sender =
        msg.key.participant ||
        msg.key.remoteJid;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        '';

      const command =
        text.trim().split(/\s+/)[0].toLowerCase();

      const args =
        text.trim().split(/\s+/).slice(1);

      /*
      ============================
      GROUP SETTINGS
      ============================
      */

      const groupSettings = isGroup(chat)
        ? getGroupSettings(chat)
        : null;

      /*
      ============================
      WELCOME
      ============================
      */

      if (
        msg.messageStubType === 27 ||
        msg.messageStubType === 28
      ) {
        if (groupSettings?.welcome) {
          const participants =
            msg.messageStubParameters || [];

          for (const participant of participants) {
            if (msg.messageStubType === 27) {
              await sock.sendMessage(chat, {
                text:
                  `👋 Welcome @${participant.split('@')[0]}!\n\n` +
                  `🤖 I'm BerylsBot.\n` +
                  `Type .menu to see my commands.`,
                mentions: [participant]
              });
            }
          }
        }

        return;
      }

      /*
      ============================
      MUTED USERS
      ============================
      */

      if (
        isGroup(chat) &&
        groupSettings.muted.includes(sender)
      ) {
        if (await isAdmin(sock, chat, sender)) return;

        try {
          await sock.sendMessage(chat, {
            delete: msg.key
          });
        } catch {}

        return;
      }

      /*
      ============================
      ANTILINK
      ============================
      */

      if (
        isGroup(chat) &&
        groupSettings.antilink &&
        /(https?:\/\/|www\.|chat\.whatsapp\.com\/)/i.test(text)
      ) {
        if (!(await isAdmin(sock, chat, sender))) {
          try {
            await sock.sendMessage(chat, {
              delete: msg.key
            });

            await sock.sendMessage(chat, {
              text:
                '🚫 Links are not allowed in this group.'
            });
          } catch {}
        }

        return;
      }

      /*
      ============================
      AUTODELETE
      ============================
      */

      if (
        isGroup(chat) &&
        groupSettings.autodelete &&
        !command.startsWith('.')
      ) {
        setTimeout(async () => {
          try {
            await sock.sendMessage(chat, {
              delete: msg.key
            });
          } catch {}
        }, 30000);
      }

      /*
      ============================
      .PING
      ============================
      */

      if (command === '.ping') {
        await sock.sendMessage(chat, {
          text:
            '🏓 Pong!\n\n🤖 BerylsBot is online.'
        });
      }

      /*
      ============================
      .MENU
      ============================
      */

      else if (command === '.menu') {
        await sock.sendMessage(chat, {
          text:
`╭━━━〔 🤖 BERYLSBOT 〕━━━╮

📌 BASIC
┃ .ping
┃ .menu
┃ .ai
┃ .character
┃ .privacy
┃ .vv
┃ .sticker

👥 GROUP
┃ .tagall
┃ .ban
┃ .mute
┃ .unmute
┃ .groupstatus

🛡️ PROTECTION
┃ .antilink on/off
┃ .autodelete on/off
┃ .welcome on/off

🎮 FUN
┃ .game
┃ .character

🎵 MUSIC
┃ .play <song>

╰━━━━━━━━━━━━━━━━━━╯`
        });
      }

      /*
      ============================
      .TAGALL
      ============================
      */

      else if (command === '.tagall') {
        if (!isGroup(chat)) {
          await sock.sendMessage(chat, {
            text:
              '❌ This command only works in groups.'
          });

          return;
        }

        if (!(await isAdmin(sock, chat, sender))) {
          await sock.sendMessage(chat, {
            text:
              '❌ Only group admins can use .tagall.'
          });

          return;
        }

        const metadata =
          await sock.groupMetadata(chat);

        const mentions =
          metadata.participants.map(p => p.id);

        const message =
          args.length > 0
            ? args.join(' ')
            : '📢 Attention everyone!';

        await sock.sendMessage(chat, {
          text:
            `${message}\n\n` +
            mentions
              .map(id => `@${id.split('@')[0]}`)
              .join(' '),
          mentions
        });
      }

      /*
      ============================
      .BAN
      ============================
      */

      else if (command === '.ban') {
        if (!isGroup(chat)) return;

        if (!(await isAdmin(sock, chat, sender))) {
          await sock.sendMessage(chat, {
            text:
              '❌ Only group admins can use .ban.'
          });

          return;
        }

        const mentioned =
          msg.message.extendedTextMessage
            ?.contextInfo?.mentionedJid || [];

        if (!mentioned.length) {
          await sock.sendMessage(chat, {
            text:
              '❌ Mention the person you want to remove.'
          });

          return;
        }

        for (const user of mentioned) {
          try {
            await sock.groupParticipantsUpdate(
              chat,
              [user],
              'remove'
            );
          } catch {}
        }

        await sock.sendMessage(chat, {
          text:
            '✅ User removed from the group.'
        });
      }

      /*
      ============================
      .MUTE
      ============================
      */

      else if (command === '.mute') {
        if (!isGroup(chat)) return;

        if (!(await isAdmin(sock, chat, sender))) {
          await sock.sendMessage(chat, {
            text:
              '❌ Only group admins can use .mute.'
          });

          return;
        }

        const mentioned =
          msg.message.extendedTextMessage
            ?.contextInfo?.mentionedJid || [];

        if (!mentioned.length) {
          await sock.sendMessage(chat, {
            text:
              '❌ Mention the person you want to mute.'
          });

          return;
        }

        for (const user of mentioned) {
          if (!groupSettings.muted.includes(user)) {
            groupSettings.muted.push(user);
          }
        }

        saveSettings();

        await sock.sendMessage(chat, {
          text: '🔇 User muted.'
        });
      }

      /*
      ============================
      .UNMUTE
      ============================
      */

      else if (command === '.unmute') {
        if (!isGroup(chat)) return;

        if (!(await isAdmin(sock, chat, sender))) {
          await sock.sendMessage(chat, {
            text:
              '❌ Only group admins can use .unmute.'
          });

          return;
        }

        const mentioned =
          msg.message.extendedTextMessage
            ?.contextInfo?.mentionedJid || [];

        if (!mentioned.length) {
          await sock.sendMessage(chat, {
            text:
              '❌ Mention the person you want to unmute.'
          });

          return;
        }

        groupSettings.muted =
          groupSettings.muted.filter(
            user => !mentioned.includes(user)
          );

        saveSettings();

        await sock.sendMessage(chat, {
          text: '🔊 User unmuted.'
        });
      }

      /*
      ============================
      .ANTILINK
      ============================
      */

      else if (command === '.antilink') {
        if (!isGroup(chat)) return;

        if (!(await isAdmin(sock, chat, sender))) {
          await sock.sendMessage(chat, {
            text: '❌ Admin only.'
          });

          return;
        }

        const value =
          args[0]?.toLowerCase();

        if (value === 'on') {
          groupSettings.antilink = true;
          saveSettings();

          await sock.sendMessage(chat, {
            text:
              '🛡️ Antilink enabled.'
          });
        }

        else if (value === 'off') {
          groupSettings.antilink = false;
          saveSettings();

          await sock.sendMessage(chat, {
            text:
              '🛡️ Antilink disabled.'
          });
        }

        else {
          await sock.sendMessage(chat, {
            text:
              `Antilink: ${
                groupSettings.antilink
                  ? 'ON'
                  : 'OFF'
              }\n\nUse:\n.antilink on\n.antilink off`
          });
        }
      }

      /*
      ============================
      .AUTODELETE
      ============================
      */

      else if (command === '.autodelete') {
        if (!isGroup(chat)) return;

        if (!(await isAdmin(sock, chat, sender))) {
          await sock.sendMessage(chat, {
            text: '❌ Admin only.'
          });

          return;
        }

        const value =
          args[0]?.toLowerCase();

        if (value === 'on') {
          groupSettings.autodelete = true;
          saveSettings();

          await sock.sendMessage(chat, {
            text:
              '🗑️ Autodelete enabled.'
          });
        }

        else if (value === 'off') {
          groupSettings.autodelete = false;
          saveSettings();

          await sock.sendMessage(chat, {
            text:
              '🗑️ Autodelete disabled.'
          });
        }

        else {
          await sock.sendMessage(chat, {
            text:
              `Autodelete: ${
                groupSettings.autodelete
                  ? 'ON'
                  : 'OFF'
              }\n\nUse:\n.autodelete on\n.autodelete off`
          });
        }
      }

      /*
      ============================
      .WELCOME
      ============================
      */

      else if (command === '.welcome') {
        if (!isGroup(chat)) return;

        if (!(await isAdmin(sock, chat, sender))) {
          await sock.sendMessage(chat, {
            text: '❌ Admin only.'
          });

          return;
        }

        const value =
          args[0]?.toLowerCase();

        if (value === 'on') {
          groupSettings.welcome = true;
          saveSettings();

          await sock.sendMessage(chat, {
            text:
              '👋 Welcome messages enabled.'
          });
        }

        else if (value === 'off') {
          groupSettings.welcome = false;
          saveSettings();

          await sock.sendMessage(chat, {
            text:
              '👋 Welcome messages disabled.'
          });
        }
      }

      /*
      ============================
      .GROUPSTATUS
      ============================
      */

      else if (command === '.groupstatus') {
        if (!isGroup(chat)) return;

        const metadata =
          await sock.groupMetadata(chat);

        await sock.sendMessage(chat, {
          text:
`📊 GROUP STATUS

👥 Members: ${metadata.participants.length}
👑 Admins: ${
  metadata.participants.filter(p => p.admin).length
}
🛡️ Antilink: ${
  groupSettings.antilink ? 'ON' : 'OFF'
}
🗑️ Autodelete: ${
  groupSettings.autodelete ? 'ON' : 'OFF'
}
👋 Welcome: ${
  groupSettings.welcome ? 'ON' : 'OFF'
}`
        });
      }

      /*
      ============================
      .CHARACTER
      ============================
      */

      else if (command === '.character') {
        const characters = [
          '⚡ The Energetic One',
          '🧠 The Smart One',
          '😂 The Comedian',
          '👑 The Leader',
          '😎 The Cool One',
          '🔥 The Fearless One',
          '💎 The Rare One',
          '🌟 The Star'
        ];

        const result =
          characters[
            Math.floor(
              Math.random() *
              characters.length
            )
          ];

        await sock.sendMessage(chat, {
          text:
            `🎭 CHARACTER RESULT\n\n` +
            `${result}\n\n` +
            `Your character has been revealed! 😭🔥`
        });
      }

      /*
      ============================
      .GAME
      ============================
      */

      else if (command === '.game') {
        const games = [
          '🎮 Truth or Dare',
          '🎮 Would You Rather',
          '🎮 Never Have I Ever',
          '🎮 Guess the Word',
          '🎮 Emoji Challenge'
        ];

        const game =
          games[
            Math.floor(
              Math.random() * games.length
            )
          ];

        await sock.sendMessage(chat, {
          text:
            `🎮 GAME TIME!\n\n` +
            `${game}\n\n` +
            `Type .game again for another game.`
        });
      }

      /*
      ============================
      .AI
      ============================
      */

      else if (command === '.ai') {
        const question = args.join(' ');

        if (!question) {
          await sock.sendMessage(chat, {
            text:
              '🤖 Usage: .ai your question'
          });

          return;
        }

        await sock.sendMessage(chat, {
          text:
            `🤖 AI feature is ready for an AI API connection.\n\n` +
            `You asked:\n${question}`
        });
      }

      /*
      ============================
      .PLAY
      ============================
      */

      else if (
        command === '.play' ||
        command === '.music'
      ) {
        const song = args.join(' ');

        if (!song) {
          await sock.sendMessage(chat, {
            text:
              '🎵 Usage: .play song name'
          });

          return;
        }

        await sock.sendMessage(chat, {
          text:
            `🎵 Music request received!\n\n` +
            `Song: ${song}\n\n` +
            `Music downloading/search will be connected after the basic bot is running.`
        });
      }

      /*
      ============================
      .PRIVACY
      ============================
      */

      else if (command === '.privacy') {
        await sock.sendMessage(chat, {
          text:
`🔐 BERYLSBOT PRIVACY

• Your messages aren't stored by this bot intentionally.
• Pairing credentials stay in the bot's session files.
• Don't share your pairing code with anyone.
• Don't put passwords or private keys inside the source code.`
        });
      }

      /*
      ============================
      .VV
      ============================
      */

      else if (command === '.vv') {
        await sock.sendMessage(chat, {
          text:
            '👀 .vv is available, but BerylsBot will not bypass WhatsApp view-once privacy protections.'
        });
      }

      /*
      ============================
      .STICKER
      ============================
      */

      else if (command === '.sticker') {
        await sock.sendMessage(chat, {
          text:
            '🖼️ Send an image with the caption .sticker to create a sticker.'
        });
      }

      /*
      ============================
      .AUTOREPLY
      ============================
      */

      else if (command === '.autoreply') {
        await sock.sendMessage(chat, {
          text:
            '🤖 Autoreply feature is enabled for future custom replies.'
        });
      }

    } catch (error) {
      console.error(
        'Message error:',
        error
      );
    }
  });
}

/*
============================
WEB SERVER
============================
*/

http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain'
  });

  res.end(
    '🤖 BerylsBot is running!'
  );
}).listen(PORT, () => {
  console.log(
    `🌐 Server running on port ${PORT}`
  );
});

startBot().catch(console.error);
