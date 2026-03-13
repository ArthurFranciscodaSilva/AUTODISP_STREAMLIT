const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const axios = require('axios'); // IMPORTAÇÃO ADICIONADA


const app = express();
const server = http.createServer(app); 

// --- MAPAS DE PERSISTÊNCIA EM MEMÓRIA ---
const campaignLogs = new Map(); // Guarda os sucessos/falhas das campanhas
const sessions = new Map();     // Guarda as instâncias do WhatsApp e histórico de chat

// --- CONFIGURAÇÃO DE MIDDLEWARES ---
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cors({ origin: 'http://localhost:5173' })); 
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Configuração do Multer para Uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './uploads';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

const io = new Server(server, {
    cors: {
        origin: "http://localhost:5173",
        methods: ["GET", "POST"],
        credentials: true
    }
});

// --- FUNÇÃO AUXILIAR PARA FOTO DE PERFIL ---
async function getSafeProfilePic(client, contactId) {
    try {
        const url = await client.getProfilePicUrl(contactId);
        return url || null;
    } catch (e) {
        return null;
    }
}

async function loadAudioFromUrl(url) {
    try {
        // Se a URL aponta para o seu próprio servidor, lemos direto do disco
        if (url.includes('127.0.0.1') || url.includes('localhost')) {
            const filename = url.split('/').pop(); // Pega apenas o '59.mp3'
            const filePath = path.join(__dirname, 'uploads', filename);

            console.log(`📂 Lendo arquivo direto do disco: ${filePath}`);

            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath);
                const base64 = content.toString('base64');
                return new MessageMedia('audio/mpeg', base64, 'audio.mp3');
            } else {
                console.error("❌ Arquivo não encontrado no caminho físico:", filePath);
            }
        }

        // Caso a URL seja externa (uma imagem da internet, por exemplo), usa o axios
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return new MessageMedia('audio/mpeg', Buffer.from(response.data).toString('base64'), 'audio.mp3');
        
    } catch (err) {
        throw new Error(`Falha total ao carregar mídia: ${err.message}`);
    }
}

async function getSafeProfilePic(client, contactId) {
    try {
        const url = await client.getProfilePicUrl(contactId);
        return url || null;
    } catch (e) { return null; }
}

// --- LÓGICA DE CONEXÃO SOCKET ---
io.on('connection', (socket) => {
    socket.on('join-session', (accountId) => {
        socket.join(accountId.toString());
        console.log(`Cliente ${socket.id} entrou na sala ${accountId}`);
    });

    socket.on('request-history', (accountId) => {
        console.log(`🙋 Cliente solicitou reenvio de histórico para: ${accountId}`);
        const session = sessions.get(accountId.toString());
        if (session && session.history) {
            socket.emit('chat-history', {
                accountId,
                messages: session.history
            });
            console.log(`✅ Histórico reenviado da memória para ${accountId}`);
        }
    });
});

// --- ROTA DE UPLOAD ---
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    // DEVE SER 127.0.0.1
    const fileUrl = `http://127.0.0.1:3001/uploads/${req.file.filename}`;
    res.json({ url: fileUrl });
});

// --- ROTA DE INICIALIZAÇÃO DO WHATSAPP ---
app.post('/api/sessions/:accountId/init', async (req, res) => {
    const { accountId } = req.params;
    console.log(`[HTTP POST] Inicializando ID: ${accountId}`);

    if (sessions.has(accountId)) {
        const existing = sessions.get(accountId);
        if (existing.client && existing.client.pupPage) {
            return res.json({ status: 'already_initialized' });
        }
    }

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: `session-${accountId}` }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', '--disable-gpu',
                '--no-first-run', '--no-zygote'
            ],
        }
    });

    sessions.set(accountId, { client, history: [] });

    client.on('qr', async (qr) => {
        try {
            const qrCodeImage = await QRCode.toDataURL(qr); 
            console.log(`QR Code gerado para ${accountId}`);
            io.to(accountId).emit('qrcode-ready', { accountId, qrCode: qrCodeImage });
        } catch (err) {
            console.error('Erro ao gerar QR Code:', err);
        }
    });

    client.on('ready', async () => {
        const phoneNumber = client.info.wid.user;
        console.log(`Sessão ${accountId} pronta: ${phoneNumber}`);

        try {
            console.log(`Carregando histórico inicial para ${accountId}...`);
            const chats = await client.getChats();
            const history = [];

            for (const chat of chats.slice(0, 20)) {
                const profilePic = await getSafeProfilePic(client, chat.id._serialized);
                const msgs = await chat.fetchMessages({ limit: 30 });
                msgs.forEach(m => {
                    history.push({
                        accountId: accountId,
                        accountPhone: phoneNumber,
                        from: m.from,
                        to: m.to,
                        body: m.body,
                        type: m.type,
                        timestamp: m.timestamp,
                        pushname: m._data.notifyName || m.from.split('@')[0],
                        isMe: m.fromMe,
                        profilePic: profilePic 
                    });
                });
            }

            sessions.set(accountId, { client, phoneNumber, history });
            io.to(accountId).emit('chat-history', { accountId, messages: history });
            io.emit('session-ready', { accountId, phoneNumber });
        } catch (err) {
            console.error("Erro ao extrair histórico:", err.message);
        }
    });

    client.on('message', async (msg) => {
        let mediaData = null;
        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                if (media) {
                    mediaData = { mimetype: media.mimetype, data: media.data, filename: media.filename };
                }
            } catch (err) {}
        }

        const profilePic = await getSafeProfilePic(client, msg.from);
        const newMessage = {
            accountId: accountId,
            accountPhone: sessions.get(accountId)?.phoneNumber,
            from: msg.from,
            to: msg.to,
            body: msg.body,
            type: msg.type,
            timestamp: msg.timestamp,
            media: mediaData,
            pushname: msg._data.notifyName || msg.from.split('@')[0],
            isMe: false,
            profilePic: profilePic 
        };

        const sess = sessions.get(accountId);
        if (sess && sess.history) sess.history.push(newMessage);
        io.emit('new-message', newMessage);
    });

    client.on('disconnected', (reason) => {
        console.log(`Session ${accountId} disconnected`);
        sessions.delete(accountId);
        io.to(accountId).emit('session-disconnected', { accountId, reason });
    });

    client.initialize().catch(err => {
        console.error(`Erro fatal no Puppeteer ${accountId}:`, err);
        sessions.delete(accountId);
    });

    res.json({ status: 'initializing' });
});

// --- ROTA DE CAMPANHA (VERSÃO CORRIGIDA PARA ERRO 'T') ---
// --- ROTA DE CAMPANHA (CORREÇÃO DE VALIDAÇÃO + ENVIO DE ÁUDIO REFORÇADO) ---
// --- ROTA DE CAMPANHA (VERSÃO BLINDADA CONTRA ERRO 'T') ---
// --- ROTA DE CAMPANHA (CORRIGIDA) ---
app.post('/api/campaigns/:campaignId/start', async (req, res) => {
    const { campaignId } = req.params;
    const { contacts, message, mediaUrl, accountId } = req.body;
    const strCampaignId = campaignId.toString();
    const safeMessage = message || "";

    const session = sessions.get(accountId?.toString());
    if (!session || !session.client) return res.status(400).json({ error: 'Offline' });

    if (!campaignLogs.has(strCampaignId)) campaignLogs.set(strCampaignId, { success: [], failed: [] });
    res.json({ status: 'processing' });

    let mediaFile = null;
    if (mediaUrl) {
        try {
            mediaFile = await loadAudioFromUrl(mediaUrl);
            console.log('🎧 Áudio carregado em memória para campanha');
        } catch (err) {
            console.error('❌ Erro ao carregar áudio:', err.message);
        }
    }

    for (const contact of contacts) {
        let status = 'error';
        let errorMsg = '';
        let cleanNumber = (contact.number || contact.phone || "").toString().replace(/\D/g, '');

        // ... dentro do seu loop for (const contact of contacts) ...

        try {
            if (cleanNumber.length <= 11) cleanNumber = '55' + cleanNumber;
            
            const numberId = await session.client.getNumberId(cleanNumber);
            if (!numberId) throw new Error('O número não tem WhatsAppp');

            const chat = await session.client.getChatById(numberId._serialized);

            // 1. COMENTE OU REMOVA ESTA LINHA (Ela é a causa principal do erro)
            // await chat.sendSeen(); 

            await new Promise(r => setTimeout(r, 2000)); 

            const finalMsg = safeMessage.replace(/{nome}/gi, contact.name || '');
            if (finalMsg) {
                // 2. ADICIONE { sendSeen: false } AQUI
                await chat.sendMessage(finalMsg, { sendSeen: false });
                console.log(`💬 Texto enviado para ${cleanNumber}. Aguardando 15s para o áudio...`);
                
                await new Promise(r => setTimeout(r, 15000)); 
            }

            if (mediaFile) {
                // 3. ADICIONE sendSeen: false AQUI TAMBÉM
                await chat.sendMessage(mediaFile, { 
                    sendAudioAsVoice: true,
                    sendSeen: false 
                });
                console.log(`🎧 Áudio enviado para ${cleanNumber}`);
                
                await new Promise(r => setTimeout(r, 2000)); 
            }

            status = 'success';
            console.log(`✅ Sucesso para: ${cleanNumber}`);
        } catch (err) {
            status = 'error';
            errorMsg = err.message.includes('WhatsAppp') ? 'O número não tem WhatsAppp' : 'Erro no envio';
            console.error(`❌ Falha: ${cleanNumber} - ${err.message}`);
        }

        const logEntry = { name: contact.name, phone_number: cleanNumber, status, error_message: errorMsg, sent_at: new Date().toISOString() };
        const logs = campaignLogs.get(strCampaignId);
        status === 'success' ? logs.success.push(logEntry) : logs.failed.push(logEntry);

        io.to(accountId.toString()).emit('campaign-progress', { campaignId: strCampaignId, contact, status, error: errorMsg });
        await new Promise(r => setTimeout(r, 5000));
    }
    io.to(accountId.toString()).emit('campaign-completed', { campaignId: strCampaignId });
});

// --- ROTA PARA RECUPERAR LOGS ---
app.get('/api/campaigns/:campaignId/logs/:type', (req, res) => {
    const { campaignId, type } = req.params;
    const logs = campaignLogs.get(campaignId.toString());
    if (!logs) return res.json([]);
    res.json(type === 'success' ? logs.success : logs.failed);
});

// --- ROTA DE EXPORTAÇÃO EXCEL ---
app.get('/api/campaigns/:campaignId/export/:type', async (req, res) => {
    const { campaignId, type } = req.params;
    const logs = campaignLogs.get(campaignId.toString());
    if (!logs) return res.status(404).send('Logs não encontrados');

    const data = type === 'success' ? logs.success : logs.failed;
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Relatório');

    worksheet.columns = [
        { header: 'Nome', key: 'name', width: 25 },
        { header: 'Telefone', key: 'phone_number', width: 20 },
        { header: 'Erro/Status', key: 'error_message', width: 35 },
        { header: 'Data do Envio', key: 'sent_at', width: 25 }
    ];

    worksheet.addRows(data);
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=relatorio_${type}_${campaignId}.xlsx`);
    
    await workbook.xlsx.write(res);
    res.end();
});

// --- ROTA DE ENVIO INDIVIDUAL ---
// --- ROTA DE ENVIO INDIVIDUAL ---
app.post('/api/sessions/:accountId/send', async (req, res) => {
    const { accountId } = req.params;
    const { phoneNumber, message, mediaUrl } = req.body;
    const session = sessions.get(accountId.toString());

    if (!session || !session.client) return res.status(400).json({ error: 'Sessão offline' });

    try {
        let cleanNumber = phoneNumber.toString().replace(/\D/g, '');
        
        // Tratamento do número
        if (cleanNumber.length <= 11) cleanNumber = '55' + cleanNumber;
        if (cleanNumber.startsWith('55') && cleanNumber.length === 13) {
            cleanNumber = cleanNumber.substring(0, 4) + cleanNumber.substring(5);
        }

        const chatId = `${cleanNumber}@c.us`;

        if (mediaUrl) {
            const media = await loadAudioFromUrl(mediaUrl);
            // ADICIONADO: { sendSeen: false }
            await session.client.sendMessage(chatId, media, { 
                caption: message || '', 
                sendSeen: false 
            });
        } else {
            // ADICIONADO: { sendSeen: false }
            await session.client.sendMessage(chatId, message, { 
                sendSeen: false 
            });
        }

        // Adiciona ao histórico na memória
        if (session.history) {
            session.history.push({
                accountId, 
                from: session.client.info.wid._serialized, 
                to: chatId,
                body: message || (mediaUrl ? "Arquivo de áudio" : ""), 
                type: 'chat', 
                timestamp: Math.floor(Date.now() / 1000), 
                isMe: true
            });
        }

        res.json({ status: 'sent', to: chatId });
    } catch (error) {
        console.error("Erro no envio individual:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- ROTA DE SINCRONIZAÇÃO DE HISTÓRICO ---
app.post('/api/sessions/:accountId/sync', async (req, res) => {
    const { accountId } = req.params;
    const session = sessions.get(accountId.toString());
    if (!session || !session.client.pupPage) return res.status(400).json({ error: 'Sessão não conectada' });

    try {
        const client = session.client;
        const phoneNumber = client.info.wid.user;
        const chats = await client.getChats();
        const history = [];
        for (const chat of chats.slice(0, 30)) { 
            const profilePic = await getSafeProfilePic(client, chat.id._serialized);
            const msgs = await chat.fetchMessages({ limit: 40 });
            msgs.forEach(m => {
                history.push({
                    accountId, accountPhone: phoneNumber, from: m.from, to: m.to, body: m.body,
                    type: m.type, timestamp: m.timestamp, profilePic,
                    pushname: m._data.notifyName || m.from.split('@')[0], isMe: m.fromMe
                });
            });
        }
        session.history = history;
        io.to(accountId).emit('chat-history', { accountId, messages: history });
        res.json({ status: 'sync_completed', count: history.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- LISTAGEM DE SESSÕES ATIVAS ---
app.get('/api/sessions/list', (req, res) => {
    const active = {};
    sessions.forEach((v, k) => { if (v.phoneNumber) active[k] = v.phoneNumber; });
    res.json(active);
});

// --- DESCONEXÃO ---
app.post('/api/sessions/:accountId/disconnect', async (req, res) => {
    const session = sessions.get(req.params.accountId);
    if (session) {
        await session.client.destroy().catch(() => {});
        sessions.delete(req.params.accountId);
    }
    res.json({ status: 'disconnected' });
});

const PORT = 3001;
server.listen(PORT, () => console.log(`🚀 Servidor rodando em http://localhost:${PORT}`));