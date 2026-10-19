
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage
} = require("@whiskeysockets/baileys");

const qrcode = require("qrcode-terminal");
const db = require("./database");

const ADMIN_NUMBER = (process.env.ADMIN_WA_NUMBER || "")
  .replace(/\D/g, "");

if (!ADMIN_NUMBER) {
  throw new Error("ADMIN_WA_NUMBER belum diatur.");
}

const adminJid = `${ADMIN_NUMBER}@s.whatsapp.net`;

db.exec(`
  CREATE TABLE IF NOT EXISTS wa_users (
    jid TEXT PRIMARY KEY,
    name TEXT,
    balance INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS wa_deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL,
    amount INTEGER NOT NULL,
    qris_sent INTEGER NOT NULL DEFAULT 0,
    proof_image TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    approved_at TEXT
  );
`);

const getText = (message) =>
  message?.conversation ||
  message?.extendedTextMessage?.text ||
  message?.imageMessage?.caption ||
  "";

const rupiah = (amount) =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(amount);

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
        setTimeout(() => startBot().catch(console.error), 3000);
      } else {
        console.log("Sesi keluar. Hubungkan ulang WhatsApp.");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        if (!jid || jid.endsWith("@g.us") || jid.endsWith("@broadcast")) {
          continue;
        }

        const isAdmin = jid === adminJid;
        const rawText = getText(msg.message).trim();
        const text = rawText.toLowerCase();

        // Admin mengirim QRIS sebagai foto dengan caption: qris ID
        if (isAdmin && msg.message.imageMessage) {
          const match = rawText.match(/^qris\s+(\d+)$/i);

          if (match) {
            const id = Number(match[1]);
            const deposit = db.prepare(`
              SELECT * FROM wa_deposits
              WHERE id = ? AND status = 'pending'
            `).get(id);

            if (!deposit) {
              await sock.sendMessage(jid, {
                text: `Deposit ID ${id} tidak ditemukan atau sudah diproses.`
              });
              continue;
            }

            const image = await downloadMediaMessage(
              msg, "buffer", {}
            );

            await sock.sendMessage(deposit.jid, {
              image,
              caption:
                `✨ *NEON STORE — QRIS DEPOSIT*\n\n` +
                `ID Deposit: ${deposit.id}\n` +
                `Nominal: ${rupiah(deposit.amount)}\n\n` +
                `Silakan bayar sesuai nominal, lalu kirim foto bukti transfer di chat ini.`
            });

            db.prepare(`
              UPDATE wa_deposits SET qris_sent = 1 WHERE id = ?
            `).run(id);

            await sock.sendMessage(jid, {
              text: `QRIS untuk deposit ID ${id} berhasil dikirim ke pelanggan.`
            });
            continue;
          }

          // Foto pelanggan dianggap sebagai bukti untuk deposit terbarunya.
          if (!isAdmin) {
            const deposit = db.prepare(`
              SELECT * FROM wa_deposits
              WHERE jid = ? AND status = 'pending' AND qris_sent = 1
              ORDER BY id DESC LIMIT 1
            `).get(jid);

            if (!deposit) {
              await sock.sendMessage(jid, {
                text: "Belum ada deposit yang menunggu bukti transfer. Ketik *deposit 10000* untuk memulai."
              });
              continue;
            }

            db.prepare(`
              UPDATE wa_deposits
              SET proof_image = 'received'
              WHERE id = ?
            `).run(deposit.id);

            const image = await downloadMediaMessage(
              msg, "buffer", {}
            );

            await sock.sendMessage(adminJid, {
              image,
              caption:
                `📥 *BUKTI TRANSFER DEPOSIT*\n\n` +
                `ID Deposit: ${deposit.id}\n` +
                `Nominal: ${rupiah(deposit.amount)}\n` +
                `Nomor pelanggan: ${jid}\n\n` +
                `Untuk menyetujui: setujui ${deposit.id}\n` +
                `Untuk menolak: tolak ${deposit.id}`
            });

            await sock.sendMessage(jid, {
              text: `Bukti transfer untuk deposit ID ${deposit.id} telah dikirim ke admin. Mohon tunggu verifikasi.`
            });
            continue;
          }
        }

        if (isAdmin) {
          const approve = text.match(/^setujui\s+(\d+)$/);
          const reject = text.match(/^tolak\s+(\d+)$/);

          if (approve) {
            const id = Number(approve[1]);
            const deposit = db.prepare(`
              SELECT * FROM wa_deposits
              WHERE id = ? AND status = 'pending'
                AND qris_sent = 1 AND proof_image IS NOT NULL
            `).get(id);

            if (!deposit) {
              await sock.sendMessage(jid, {
                text: "Deposit tidak ditemukan, belum ada bukti transfer, atau sudah diproses."
              });
              continue;
            }

            const approveDeposit = db.transaction(() => {
              const result = db.prepare(`
                UPDATE wa_deposits
                SET status = 'approved',
                    approved_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = 'pending'
                  AND qris_sent = 1 AND proof_image IS NOT NULL
              `).run(id);

              if (result.changes !== 1) return false;

              db.prepare(`
                INSERT INTO wa_users (jid, balance)
                VALUES (?, ?)
                ON CONFLICT(jid) DO UPDATE
                SET balance = balance + excluded.balance
              `).run(deposit.jid, deposit.amount);

              return true;
            });

            if (!approveDeposit()) {
              await sock.sendMessage(jid, {
                text: "Deposit sudah diproses oleh tindakan lain."
              });
              continue;
            }

            const user = db.prepare(
              "SELECT balance FROM wa_users WHERE jid = ?"
            ).get(deposit.jid);

            await sock.sendMessage(deposit.jid, {
              text:
                `✅ *DEPOSIT DISETUJUI — NEON STORE*\n\n` +
                `Nominal: ${rupiah(deposit.amount)}\n` +
                `Saldo sekarang: ${rupiah(user.balance)}\n` +
                `Nomor pelanggan: ${deposit.jid}\n\n` +
                `Selamat menikmati layanan NEON STORE!`
            });

            await sock.sendMessage(jid, {
              text: `Deposit ID ${id} disetujui. Saldo pelanggan bertambah ${rupiah(deposit.amount)}.`
            });
            continue;
          }

          if (reject) {
            const id = Number(reject[1]);
            const deposit = db.prepare(`
              SELECT * FROM wa_deposits
              WHERE id = ? AND status = 'pending'
            `).get(id);

            if (!deposit) {
              await sock.sendMessage(jid, {
                text: "Deposit tidak ditemukan atau sudah diproses."
              });
              continue;
            }

            db.prepare(`
              UPDATE wa_deposits
              SET status = 'rejected'
              WHERE id = ? AND status = 'pending'
            `).run(id);

            await sock.sendMessage(deposit.jid, {
              text:
                `❌ Deposit ID ${id} ditolak admin.\n` +
                `Jika Anda sudah membayar, silakan hubungi admin NEON STORE.`
            });

            await sock.sendMessage(jid, {
              text: `Deposit ID ${id} telah ditolak.`
            });
            continue;
          }

          if (text === "menu" || text === "halo" || text === "hai") {
            await sock.sendMessage(jid, {
              text:
                "🛠️ *ADMIN NEON STORE*\n\n" +
                "Kirim QRIS sebagai foto dengan caption:\n" +
                "*qris ID*\n\n" +
                "Setujui deposit:\n*setujui ID*\n\n" +
                "Tolak deposit:\n*tolak ID*"
            });
          }
          continue;
        }

        if (text === "menu" || text === "halo" || text === "hai") {
          await sock.sendMessage(jid, {
            text:
              "✨ *NEON STORE — WHATSAPP*\n\n" +
              "Ketik *deposit 10000* untuk meminta deposit Rp10.000.\n" +
              "Ganti nominal sesuai kebutuhan.\n\n" +
              "Ketik *saldo* untuk melihat saldo."
          });
          continue;
        }

        const depositMatch = text.match(/^deposit\s+(\d+)$/);

        if (depositMatch) {
          const amount = Number(depositMatch[1]);

          if (!Number.isSafeInteger(amount) || amount < 1000) {
            await sock.sendMessage(jid, {
              text: "Minimal deposit Rp1.000. Contoh: *deposit 10000*"
            });
            continue;
          }

          db.prepare(`
            INSERT INTO wa_users (jid) VALUES (?)
            ON CONFLICT(jid) DO NOTHING
          `).run(jid);

          const result = db.prepare(`
            INSERT INTO wa_deposits (jid, amount)
            VALUES (?, ?)
          `).run(jid, amount);

          await sock.sendMessage(jid, {
            text:
              `🧾 *PERMINTAAN DEPOSIT DIBUAT*\n\n` +
              `ID Deposit: ${result.lastInsertRowid}\n` +
              `Nominal: ${rupiah(amount)}\n\n` +
              `Permintaan Anda sudah diteruskan ke admin. Tunggu QRIS dikirim sebelum melakukan pembayaran.`
          });

          await sock.sendMessage(adminJid, {
            text:
              `📥 *PERMINTAAN DEPOSIT BARU*\n\n` +
              `ID Deposit: ${result.lastInsertRowid}\n` +
              `Nominal: ${rupiah(amount)}\n` +
              `Nomor pelanggan: ${jid}\n\n` +
              `Kirim foto QRIS dengan caption:\nqris ${result.lastInsertRowid}`
          });
          continue;
        }

        if (text === "saldo") {
          const user = db.prepare(
            "SELECT balance FROM wa_users WHERE jid = ?"
          ).get(jid);

          await sock.sendMessage(jid, {
            text: `💰 Saldo NEON STORE Anda: ${rupiah(user?.balance || 0)}`
          });
        }
      } catch (error) {
        console.error("Gagal memproses pesan:", error);
      }
    }
  });
}

startBot().catch(console.error);
