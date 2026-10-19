
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const qrcode = require("qrcode-terminal");

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState("auth_info");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("Pindai QR WhatsApp ini:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("Bot WhatsApp NEON STORE berhasil terhubung.");
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        startBot();
      } else {
        console.log("Sesi keluar. Hubungkan ulang WhatsApp.");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe || msg.key.remoteJid.endsWith("@g.us")) {
        continue;
      }

      const jid = msg.key.remoteJid;
      const text = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        ""
      ).trim().toLowerCase();

      if (text === "menu" || text === "halo" || text === "hai") {
        await sock.sendMessage(jid, {
          text:
            "✨ *NEON STORE — WHATSAPP*\n\n" +
            "Selamat datang!\n" +
            "Bot ini sedang dalam tahap pemasangan.\n\n" +
            "Ketik *menu* untuk melihat pesan ini kembali."
        });
      }
    }
  });
}

startBot().catch(console.error);
