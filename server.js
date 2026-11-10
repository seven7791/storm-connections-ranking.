require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { AccessToken, RoomServiceClient } = require("livekit-server-sdk");
const path = require("path");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");

const app = express();

const PORT = process.env.PORT || 3000;
const BOARD_ID = "754526789448";
const SCOREBOARDS_API_KEY = process.env.SCOREBOARDS_API_KEY;

// ==========================================
// CLOUDINARY
// ==========================================

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 1
    },
    fileFilter: (req, file, callback) => {
        if (!/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) {
            return callback(
                new Error("Envie uma imagem JPG, PNG, WEBP ou GIF.")
            );
        }

        callback(null, true);
    }
});

// ==========================================
// CONFIGURAÇÃO E VARIÁVEIS
// ==========================================

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL não configurada.");
}

if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    throw new Error(
        "ADMIN_USERNAME e ADMIN_PASSWORD precisam estar configuradas."
    );
}

if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET não configurada no Render.");
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false
});

const ADMIN_PASSWORD_HASH = bcrypt.hashSync(
    process.env.ADMIN_PASSWORD,
    12
);

// ==========================================
// EXPRESS E SESSÃO
// ==========================================

app.set("trust proxy", 1);

app.use(express.json({ limit: "20kb" }));

const sessionMiddleware = session({
    store: new PgSession({
        pool,
        tableName: "user_sessions",
        createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 8 * 60 * 60 * 1000
    }
});

app.use(sessionMiddleware);

app.use(express.static(__dirname));

// ==========================================
// TABELAS DO POSTGRESQL
// ==========================================

async function createPlayerPhotosTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS player_photos (
            id BIGSERIAL PRIMARY KEY,
            player_type VARCHAR(20) NOT NULL
                CHECK (player_type IN ('scoreboards', 'challenge')),
            player_id VARCHAR(100) NOT NULL,
            player_name VARCHAR(60) NOT NULL,
            photo_url TEXT NOT NULL,
            public_id TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (player_type, player_id)
        )
    `);

    console.log("Tabela player_photos verificada.");
}

// ==========================================
// CONTAS, CANAIS, MODERAÇÃO E TRANSMISSÕES
// ==========================================

async function createLivePlatformTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS storm_users (
            id BIGSERIAL PRIMARY KEY,
            username VARCHAR(32) NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role VARCHAR(20) NOT NULL DEFAULT 'viewer'
                CHECK (role IN ('viewer', 'narrator', 'admin')),
            is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS storm_users_username_lower_idx
        ON storm_users (LOWER(username))
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS storm_channels (
            id BIGSERIAL PRIMARY KEY,
            owner_user_id BIGINT NOT NULL REFERENCES storm_users(id),
            title VARCHAR(80) NOT NULL,
            slug VARCHAR(100) NOT NULL UNIQUE,
            description VARCHAR(500) NOT NULL DEFAULT '',
            banner_url TEXT,
            avatar_url TEXT,
            theme_bg VARCHAR(7) NOT NULL DEFAULT '#050f1d',
            theme_panel VARCHAR(7) NOT NULL DEFAULT '#0c1d30',
            theme_primary VARCHAR(7) NOT NULL DEFAULT '#5bbcff',
            theme_text VARCHAR(7) NOT NULL DEFAULT '#eaf4ff',
            visibility VARCHAR(12) NOT NULL DEFAULT 'public'
                CHECK (visibility IN ('public', 'private')),
            access_code_hash TEXT,
            is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
            transmission_blocked BOOLEAN NOT NULL DEFAULT FALSE,
            live_status VARCHAR(12) NOT NULL DEFAULT 'offline'
                CHECK (live_status IN ('offline', 'live')),
            live_room_name VARCHAR(120),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK ((visibility = 'public') OR access_code_hash IS NOT NULL)
        )
    `);

    // Migração segura para canais criados antes da personalização visual.
    await pool.query(`ALTER TABLE storm_channels ADD COLUMN IF NOT EXISTS avatar_url TEXT`);
    await pool.query(`ALTER TABLE storm_channels ADD COLUMN IF NOT EXISTS theme_bg VARCHAR(7) NOT NULL DEFAULT '#050f1d'`);
    await pool.query(`ALTER TABLE storm_channels ADD COLUMN IF NOT EXISTS theme_panel VARCHAR(7) NOT NULL DEFAULT '#0c1d30'`);
    await pool.query(`ALTER TABLE storm_channels ADD COLUMN IF NOT EXISTS theme_primary VARCHAR(7) NOT NULL DEFAULT '#5bbcff'`);
    await pool.query(`ALTER TABLE storm_channels ADD COLUMN IF NOT EXISTS theme_text VARCHAR(7) NOT NULL DEFAULT '#eaf4ff'`);
    await pool.query(`ALTER TABLE storm_channels ADD COLUMN IF NOT EXISTS live_heartbeat_at TIMESTAMPTZ`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS storm_channel_moderators (
            id BIGSERIAL PRIMARY KEY,
            channel_id BIGINT NOT NULL REFERENCES storm_channels(id) ON DELETE CASCADE,
            user_id BIGINT NOT NULL REFERENCES storm_users(id) ON DELETE CASCADE,
            request_status VARCHAR(12) NOT NULL DEFAULT 'pending'
                CHECK (request_status IN ('pending', 'approved', 'rejected')),
            requested_by BIGINT REFERENCES storm_users(id),
            reviewed_by BIGINT REFERENCES storm_users(id),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            reviewed_at TIMESTAMPTZ,
            UNIQUE(channel_id, user_id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS storm_channel_comments (
            id BIGSERIAL PRIMARY KEY,
            channel_id BIGINT NOT NULL REFERENCES storm_channels(id) ON DELETE CASCADE,
            user_id BIGINT NOT NULL REFERENCES storm_users(id) ON DELETE CASCADE,
            username VARCHAR(32) NOT NULL,
            message VARCHAR(1000) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS storm_comments_channel_idx
        ON storm_channel_comments(channel_id, created_at DESC)
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS storm_channel_user_actions (
            id BIGSERIAL PRIMARY KEY,
            channel_id BIGINT NOT NULL REFERENCES storm_channels(id) ON DELETE CASCADE,
            user_id BIGINT NOT NULL REFERENCES storm_users(id) ON DELETE CASCADE,
            action_type VARCHAR(12) NOT NULL CHECK (action_type IN ('timeout', 'ban')),
            expires_at TIMESTAMPTZ,
            created_by BIGINT REFERENCES storm_users(id),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(channel_id, user_id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS storm_live_sessions (
            id BIGSERIAL PRIMARY KEY,
            channel_id BIGINT NOT NULL REFERENCES storm_channels(id) ON DELETE CASCADE,
            room_name VARCHAR(120) NOT NULL,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ended_at TIMESTAMPTZ,
            ended_by BIGINT REFERENCES storm_users(id)
        )
    `);

    // Migração: o mesmo nome de sala pode ser reutilizado em transmissões futuras.
    await pool.query(`
        ALTER TABLE storm_live_sessions
        DROP CONSTRAINT IF EXISTS storm_live_sessions_room_name_key
    `);
    await pool.query(`
        DROP INDEX IF EXISTS storm_live_sessions_room_name_key
    `);

    // Se existirem sessões abertas duplicadas, mantém somente a mais recente.
    await pool.query(`
        WITH ranked AS (
            SELECT id,
                   ROW_NUMBER() OVER (
                       PARTITION BY channel_id
                       ORDER BY started_at DESC, id DESC
                   ) AS position
            FROM storm_live_sessions
            WHERE ended_at IS NULL
        )
        UPDATE storm_live_sessions AS sessions
        SET ended_at = NOW()
        FROM ranked
        WHERE sessions.id = ranked.id
          AND ranked.position > 1
    `);

    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS storm_live_sessions_one_active_per_channel
        ON storm_live_sessions (channel_id)
        WHERE ended_at IS NULL
    `);

    // Libera canais que ficaram presos como "ao vivo" sem sessão ativa.
    await pool.query(`
        UPDATE storm_channels AS channels
        SET live_status = 'offline',
            live_room_name = NULL,
            live_heartbeat_at = NULL,
            updated_at = NOW()
        WHERE channels.live_status = 'live'
          AND NOT EXISTS (
              SELECT 1
              FROM storm_live_sessions AS sessions
              WHERE sessions.channel_id = channels.id
                AND sessions.ended_at IS NULL
          )
    `);

    console.log("Tabelas da plataforma de transmissões verificadas.");
}

// ==========================================
// FUNÇÕES GERAIS
// ==========================================

function sendApiError(res, error) {
    console.error(error);

    res.status(error.status || 500).json({
        error: true,
        message: error.status
            ? error.message
            : "Ocorreu um erro interno no servidor."
    });
}

function requireAdmin(req, res, next) {
    if (req.session && req.session.isAdmin === true) {
        return next();
    }

    return res.status(401).json({
        error: true,
        message: "Faça login como administrador."
    });
}

function cleanText(value) {
    return typeof value === "string" ? value.trim() : "";
}

function validNumericId(value) {
    return typeof value === "string" && /^\d+$/.test(value);
}

// ==========================================
// FOTOS — ASSOCIAR AO RANKING E PERFIL
// ==========================================

async function getPlayerPhotos(playerType) {
    const result = await pool.query(
        `SELECT player_id, player_name, photo_url
         FROM player_photos
         WHERE player_type = $1`,
        [playerType]
    );

    return result.rows;
}

function attachPhotos(data, photos) {
    const byId = new Map();
    const byName = new Map();

    for (const photo of photos) {
        byId.set(String(photo.player_id), photo);

        byName.set(
            photo.player_name.trim().toLowerCase(),
            photo
        );
    }

    function walk(value) {
        if (Array.isArray(value)) {
            return value.map(walk);
        }

        if (!value || typeof value !== "object") {
            return value;
        }

        const result = {};

        for (const [key, child] of Object.entries(value)) {
            result[key] = walk(child);
        }

        const idFields = [
            "player_id",
            "playerId",
            "id",
            "user_id",
            "userId",
            "discord_id",
            "discordId"
        ];

        const nameFields = [
            "player_name",
            "playerName",
            "username",
            "display_name",
            "displayName",
            "name"
        ];

        let photo = null;

        for (const field of idFields) {
            const id = result[field];

            if (id !== undefined && id !== null) {
                photo = byId.get(String(id));

                if (photo) break;
            }
        }

        if (!photo) {
            for (const field of nameFields) {
                const name = result[field];

                if (typeof name === "string" && name.trim()) {
                    photo = byName.get(name.trim().toLowerCase());

                    if (photo) break;
                }
            }
        }

        if (photo) {
            result.photo_url = photo.photo_url;
            result.photo = photo.photo_url;
        }

        return result;
    }

    return walk(data);
}

// ==========================================
// SCOREBOARDS.DEV
// ==========================================

async function scoreboardsFetch(endpoint) {
    if (!SCOREBOARDS_API_KEY) {
        throw new Error("SCOREBOARDS_API_KEY não configurada.");
    }

    const response = await fetch(
        "https://api.scoreboards.dev/v1" + endpoint,
        {
            method: "GET",
            headers: {
                Authorization: "Bearer " + SCOREBOARDS_API_KEY,
                Accept: "application/json"
            }
        }
    );

    const text = await response.text();

    if (!response.ok) {
        const error = new Error(
            "Scoreboards respondeu HTTP " + response.status
        );

        error.status = response.status;

        console.error(
            "ERRO SCOREBOARDS:",
            response.status,
            text
        );

        throw error;
    }

    try {
        return text ? JSON.parse(text) : {};
    } catch {
        throw new Error("Resposta inválida do Scoreboards.");
    }
}

// ==========================================
// RANKING PRINCIPAL COM FOTOS
// ==========================================

app.get("/api/ranking", async (req, res) => {
    try {
        const limit = Math.min(
            Math.max(Number(req.query.limit) || 200, 1),
            200
        );

        const data = await scoreboardsFetch(
            "/boards/" +
            encodeURIComponent(BOARD_ID) +
            "/entries?limit=" +
            limit
        );

        const photos = await getPlayerPhotos("scoreboards");

        res.json(attachPhotos(data, photos));
    } catch (error) {
        sendApiError(res, error);
    }
});

// ==========================================
// HISTÓRICO DE PARTIDAS
// ==========================================

app.get("/api/matches", async (req, res) => {
    try {
        const limit = Math.min(
            Math.max(Number(req.query.limit) || 25, 1),
            200
        );

        let endpoint =
            "/boards/" + encodeURIComponent(BOARD_ID) +
            "/matches?limit=" + limit +
            "&status=approved";

        if (req.query.cursor) {
            endpoint += "&cursor=" +
                encodeURIComponent(req.query.cursor);
        }

        res.json(await scoreboardsFetch(endpoint));
    } catch (error) {
        sendApiError(res, error);
    }
});

// ==========================================
// PARTIDAS DE UM JOGADOR
// ==========================================

app.get("/api/player/:playerId/matches", async (req, res) => {
    try {
        const limit = Math.min(
            Math.max(Number(req.query.limit) || 200, 1),
            200
        );

        let endpoint =
            "/boards/" + encodeURIComponent(BOARD_ID) +
            "/matches?player=" +
            encodeURIComponent(req.params.playerId) +
            "&limit=" + limit +
            "&status=approved";

        if (req.query.cursor) {
            endpoint += "&cursor=" +
                encodeURIComponent(req.query.cursor);
        }

        res.json(await scoreboardsFetch(endpoint));
    } catch (error) {
        sendApiError(res, error);
    }
});

// ==========================================
// PERFIL DO JOGADOR COM FOTO
// ==========================================

app.get("/api/player/:playerId", async (req, res) => {
    try {
        const data = await scoreboardsFetch(
            "/boards/" + encodeURIComponent(BOARD_ID) +
            "/entries/" + encodeURIComponent(req.params.playerId)
        );

        const photos = await getPlayerPhotos("scoreboards");

        res.json(attachPhotos(data, photos));
    } catch (error) {
        sendApiError(res, error);
    }
});

// ==========================================
// CONSULTAR FOTOS DOS JOGADORES
// ==========================================

app.get("/api/player-photos", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT player_type, player_id, player_name, photo_url
            FROM player_photos
            ORDER BY player_name
        `);

        res.set("Cache-Control", "no-store");
        res.json(result.rows);
    } catch (error) {
        sendApiError(res, error);
    }
});

// ==========================================
// UPLOAD DE FOTOS — ADMIN
// ==========================================

app.post(
    "/api/admin/player-photo",
    requireAdmin,
    (req, res, next) => {
        imageUpload.single("photo")(req, res, (error) => {
            if (error) {
                return res.status(400).json({
                    error: true,
                    message: error.message ||
                        "Não foi possível receber a imagem."
                });
            }

            next();
        });
    },
    async (req, res) => {
        const playerType = cleanText(req.body?.player_type);
        const playerId = cleanText(req.body?.player_id);
        const playerName = cleanText(req.body?.player_name);

        if (!req.file) {
            return res.status(400).json({
                error: true,
                message: "Selecione uma imagem."
            });
        }

        if (!["scoreboards", "challenge"].includes(playerType)) {
            return res.status(400).json({
                error: true,
                message: "Tipo de jogador inválido."
            });
        }

        if (
            !playerId ||
            playerId.length > 100 ||
            !playerName ||
            playerName.length > 60
        ) {
            return res.status(400).json({
                error: true,
                message: "ID ou nome do jogador inválido."
            });
        }

        if (
            !process.env.CLOUDINARY_CLOUD_NAME ||
            !process.env.CLOUDINARY_API_KEY ||
            !process.env.CLOUDINARY_API_SECRET
        ) {
            return res.status(503).json({
                error: true,
                message:
                    "As variáveis do Cloudinary não estão configuradas."
            });
        }

        try {
            const uploaded = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    {
                        folder: "academia-storm/players",
                        resource_type: "image",
                        transformation: [{
                            width: 600,
                            height: 600,
                            crop: "limit",
                            quality: "auto",
                            fetch_format: "auto"
                        }]
                    },
                    (error, result) => {
                        if (error) {
                            reject(error);
                        } else {
                            resolve(result);
                        }
                    }
                );

                stream.end(req.file.buffer);
            });

            const result = await pool.query(`
                INSERT INTO player_photos
                    (player_type, player_id, player_name,
                     photo_url, public_id)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (player_type, player_id)
                DO UPDATE SET
                    player_name = EXCLUDED.player_name,
                    photo_url = EXCLUDED.photo_url,
                    public_id = EXCLUDED.public_id,
                    updated_at = NOW()
                RETURNING player_type, player_id, player_name, photo_url
            `, [
                playerType,
                playerId,
                playerName,
                uploaded.secure_url,
                uploaded.public_id
            ]);

            res.status(201).json({
                success: true,
                photo: result.rows[0]
            });
        } catch (error) {
            console.error(
                "Erro no upload Cloudinary:",
                error.message || error
            );

            sendApiError(res, error);
        }
    }
);

// ==========================================
// LOGIN ADMINISTRATIVO
// ==========================================

app.get("/api/admin/session", (req, res) => {
    res.json({
        authenticated: req.session?.isAdmin === true
    });
});

app.post("/api/admin/login", async (req, res) => {
    try {
        const { username, password } = req.body || {};

        if (
            typeof username !== "string" ||
            typeof password !== "string" ||
            username !== process.env.ADMIN_USERNAME ||
            !(await bcrypt.compare(password, ADMIN_PASSWORD_HASH))
        ) {
            return res.status(401).json({
                error: true,
                message: "Usuário ou senha incorretos."
            });
        }

        req.session.regenerate((error) => {
            if (error) {
                console.error(error);

                return res.status(500).json({
                    error: true,
                    message: "Não foi possível iniciar a sessão."
                });
            }

            req.session.isAdmin = true;

            req.session.save((saveError) => {
                if (saveError) {
                    console.error(saveError);

                    return res.status(500).json({
                        error: true,
                        message: "Não foi possível salvar a sessão."
                    });
                }

                res.json({ success: true });
            });
        });
    } catch (error) {
        sendApiError(res, error);
    }
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            return res.status(500).json({
                error: true,
                message: "Não foi possível sair."
            });
        }

        res.clearCookie("connect.sid", {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax"
        });

        res.json({ success: true });
    });
});

// ==========================================
// RANKING DE DESAFIOS — POSTGRESQL
// ==========================================

app.get("/api/challenge-ranking", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                cp.id,
                cp.rank_position,
                cp.player_name,
                pp.photo_url
            FROM challenge_players cp
            LEFT JOIN player_photos pp
                ON pp.player_type = 'challenge'
                AND pp.player_id = cp.id::text
            ORDER BY cp.rank_position ASC, cp.id ASC
        `);

        res.json(result.rows);
    } catch (error) {
        sendApiError(res, error);
    }
});

// ==========================================
// ADICIONAR JOGADOR AO RANKING DE DESAFIOS
// ==========================================

app.post(
    "/api/admin/challenge-ranking",
    requireAdmin,
    async (req, res) => {
        const playerName = cleanText(req.body?.player_name);
        const requestedPosition = Number(req.body?.rank_position);

        if (
            !playerName ||
            playerName.length > 60 ||
            !Number.isInteger(requestedPosition) ||
            requestedPosition < 1
        ) {
            return res.status(400).json({
                error: true,
                message:
                    "Informe um nome de até 60 caracteres e uma posição válida."
            });
        }

        let client;

        try {
            client = await pool.connect();
            await client.query("BEGIN");

            const list = await client.query(
                "SELECT id FROM challenge_players ORDER BY rank_position, id"
            );

            if (requestedPosition > list.rowCount + 1) {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    error: true,
                    message: "A posição deve estar entre 1 e " +
                        (list.rowCount + 1) + "."
                });
            }

            const created = await client.query(
                `INSERT INTO challenge_players (player_name, rank_position)
                 VALUES ($1, $2)
                 RETURNING id`,
                [playerName, list.rowCount + 1]
            );

            const ids = list.rows.map(row => Number(row.id));

            ids.splice(
                requestedPosition - 1,
                0,
                Number(created.rows[0].id)
            );

            for (let i = 0; i < ids.length; i++) {
                await client.query(
                    `UPDATE challenge_players
                     SET rank_position = $1
                     WHERE id = $2`,
                    [i + 1, ids[i]]
                );
            }

            await client.query("COMMIT");
            res.status(201).json({ success: true });
        } catch (error) {
            if (client) {
                await client.query("ROLLBACK").catch(() => {});
            }

            sendApiError(res, error);
        } finally {
            if (client) client.release();
        }
    }
);

// ==========================================
// EDITAR JOGADOR DO RANKING DE DESAFIOS
// ==========================================

app.patch(
    "/api/admin/challenge-ranking/:id",
    requireAdmin,
    async (req, res) => {
        const id = Number(req.params.id);
        const playerName = cleanText(req.body?.player_name);

        if (!Number.isInteger(id) || id < 1) {
            return res.status(400).json({
                error: true,
                message: "ID inválido."
            });
        }

        if (!playerName || playerName.length > 60) {
            return res.status(400).json({
                error: true,
                message: "O nome deve ter entre 1 e 60 caracteres."
            });
        }

        try {
            const result = await pool.query(
                `UPDATE challenge_players
                 SET player_name = $1
                 WHERE id = $2
                 RETURNING id, rank_position, player_name`,
                [playerName, id]
            );

            if (!result.rowCount) {
                return res.status(404).json({
                    error: true,
                    message: "Jogador não encontrado."
                });
            }

            res.json({
                success: true,
                player: result.rows[0]
            });
        } catch (error) {
            sendApiError(res, error);
        }
    }
);

// ==========================================
// REORDENAR RANKING DE DESAFIOS
// ==========================================

app.put(
    "/api/admin/challenge-ranking/reorder",
    requireAdmin,
    async (req, res) => {
        const ids = req.body?.ids;

        if (
            !Array.isArray(ids) ||
            ids.some(id => !Number.isInteger(Number(id))) ||
            new Set(ids.map(Number)).size !== ids.length
        ) {
            return res.status(400).json({
                error: true,
                message: "Envie uma lista válida de IDs sem duplicatas."
            });
        }

        let client;

        try {
            client = await pool.connect();
            await client.query("BEGIN");

            const current = await client.query(
                "SELECT id FROM challenge_players ORDER BY rank_position, id"
            );

            const currentIds = current.rows.map(row => Number(row.id));
            const desiredIds = ids.map(Number);

            if (
                currentIds.length !== desiredIds.length ||
                currentIds.some(id => !desiredIds.includes(id))
            ) {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    error: true,
                    message: "A lista precisa conter todos os jogadores atuais."
                });
            }

            for (let i = 0; i < desiredIds.length; i++) {
                await client.query(
                    `UPDATE challenge_players
                     SET rank_position = $1
                     WHERE id = $2`,
                    [i + 1, desiredIds[i]]
                );
            }

            await client.query("COMMIT");
            res.json({ success: true });
        } catch (error) {
            if (client) {
                await client.query("ROLLBACK").catch(() => {});
            }

            sendApiError(res, error);
        } finally {
            if (client) client.release();
        }
    }
);

// ==========================================
// EXCLUIR JOGADOR DO RANKING DE DESAFIOS
// ==========================================

app.delete(
    "/api/admin/challenge-ranking/:id",
    requireAdmin,
    async (req, res) => {
        const id = Number(req.params.id);

        if (!Number.isInteger(id) || id < 1) {
            return res.status(400).json({
                error: true,
                message: "ID inválido."
            });
        }

        let client;

        try {
            client = await pool.connect();
            await client.query("BEGIN");

            const current = await client.query(
                "SELECT id FROM challenge_players ORDER BY rank_position, id"
            );

            const ids = current.rows
                .map(row => Number(row.id))
                .filter(playerId => playerId !== id);

            const deleted = await client.query(
                "DELETE FROM challenge_players WHERE id = $1 RETURNING id",
                [id]
            );

            if (!deleted.rowCount) {
                await client.query("ROLLBACK");

                return res.status(404).json({
                    error: true,
                    message: "Jogador não encontrado."
                });
            }

            // Remove também a referência da foto no banco.
            await client.query(
                `DELETE FROM player_photos
                 WHERE player_type = 'challenge'
                 AND player_id = $1`,
                [String(id)]
            );

            for (let i = 0; i < ids.length; i++) {
                await client.query(
                    `UPDATE challenge_players
                     SET rank_position = $1
                     WHERE id = $2`,
                    [i + 1, ids[i]]
                );
            }

            await client.query("COMMIT");
            res.json({ success: true });
        } catch (error) {
            if (client) {
                await client.query("ROLLBACK").catch(() => {});
            }

            sendApiError(res, error);
        } finally {
            if (client) client.release();
        }
    }
);

// ==========================================
// SISTEMA DE SUPORTE — TABELAS
// ==========================================

async function createSupportTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS support_tickets (
            id BIGSERIAL PRIMARY KEY,
            access_code VARCHAR(64) UNIQUE NOT NULL,
            player_name VARCHAR(60) NOT NULL,
            subject VARCHAR(100) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'aberto'
                CHECK (status IN ('aberto', 'atendimento', 'resolvido')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS support_messages (
            id BIGSERIAL PRIMARY KEY,
            ticket_id BIGINT NOT NULL
                REFERENCES support_tickets(id) ON DELETE CASCADE,
            sender VARCHAR(10) NOT NULL
                CHECK (sender IN ('jogador', 'admin')),
            message TEXT NOT NULL
                CHECK (char_length(message) BETWEEN 1 AND 4000),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS support_messages_ticket_idx
        ON support_messages(ticket_id, created_at)
    `);
}

// ==========================================
// SUPORTE — ABRIR CHAMADO
// ==========================================

app.post("/api/support/tickets", async (req, res) => {
    const playerName = cleanText(req.body?.player_name);
    const subject = cleanText(req.body?.subject);
    const message = cleanText(req.body?.message);

    if (
        playerName.length < 2 ||
        playerName.length > 60 ||
        subject.length < 3 ||
        subject.length > 100 ||
        message.length < 5 ||
        message.length > 4000
    ) {
        return res.status(400).json({
            error: true,
            message: "Confira o nome, o assunto e a mensagem."
        });
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const accessCode = crypto.randomBytes(24).toString("hex");

        const result = await client.query(
            `INSERT INTO support_tickets
                (access_code, player_name, subject)
             VALUES ($1, $2, $3)
             RETURNING id, access_code, player_name, subject,
                       status, created_at`,
            [accessCode, playerName, subject]
        );

        const ticket = result.rows[0];

        await client.query(
            `INSERT INTO support_messages (ticket_id, sender, message)
             VALUES ($1, 'jogador', $2)`,
            [ticket.id, message]
        );

        await client.query("COMMIT");

        res.set("Cache-Control", "no-store");

        res.status(201).json({
            success: true,
            ticket: {
                id: ticket.id,
                code: ticket.access_code,
                player_name: ticket.player_name,
                subject: ticket.subject,
                status: ticket.status,
                created_at: ticket.created_at
            },
            message: "Chamado criado. Guarde seu código de acesso."
        });
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        sendApiError(res, error);
    } finally {
        client.release();
    }
});

// ==========================================
// SUPORTE — CONSULTAR CHAMADO
// ==========================================

app.get("/api/support/tickets/:code", async (req, res) => {
    const code = String(req.params.code || "");

    if (!/^[a-f0-9]{48}$/.test(code)) {
        return res.status(400).json({
            error: true,
            message: "Código de chamado inválido."
        });
    }

    try {
        const result = await pool.query(
            `SELECT id, access_code, player_name, subject,
                    status, created_at, updated_at
             FROM support_tickets
             WHERE access_code = $1`,
            [code]
        );

        if (!result.rowCount) {
            return res.status(404).json({
                error: true,
                message: "Chamado não encontrado."
            });
        }

        const ticket = result.rows[0];

        const messages = await pool.query(
            `SELECT sender, message, created_at
             FROM support_messages
             WHERE ticket_id = $1
             ORDER BY created_at ASC, id ASC`,
            [ticket.id]
        );

        res.set("Cache-Control", "no-store");

        res.json({
            ticket: {
                code: ticket.access_code,
                player_name: ticket.player_name,
                subject: ticket.subject,
                status: ticket.status,
                created_at: ticket.created_at,
                updated_at: ticket.updated_at
            },
            messages: messages.rows
        });
    } catch (error) {
        sendApiError(res, error);
    }
});

// ==========================================
// SUPORTE — MENSAGEM DO JOGADOR
// ==========================================

app.post("/api/support/tickets/:code/messages", async (req, res) => {
    const code = String(req.params.code || "");
    const message = cleanText(req.body?.message);

    if (!/^[a-f0-9]{48}$/.test(code)) {
        return res.status(400).json({
            error: true,
            message: "Código de chamado inválido."
        });
    }

    if (!message || message.length > 4000) {
        return res.status(400).json({
            error: true,
            message: "A mensagem deve ter entre 1 e 4000 caracteres."
        });
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const result = await client.query(
            `SELECT id, status
             FROM support_tickets
             WHERE access_code = $1
             FOR UPDATE`,
            [code]
        );

        if (!result.rowCount) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                error: true,
                message: "Chamado não encontrado."
            });
        }

        const ticket = result.rows[0];

        if (ticket.status === "resolvido") {
            await client.query("ROLLBACK");

            return res.status(409).json({
                error: true,
                message: "Este chamado está resolvido."
            });
        }

        await client.query(
            `INSERT INTO support_messages (ticket_id, sender, message)
             VALUES ($1, 'jogador', $2)`,
            [ticket.id, message]
        );

        await client.query(
            `UPDATE support_tickets
             SET updated_at = NOW()
             WHERE id = $1`,
            [ticket.id]
        );

        await client.query("COMMIT");
        res.status(201).json({ success: true });
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        sendApiError(res, error);
    } finally {
        client.release();
    }
});

// ==========================================
// SUPORTE — LISTAR CHAMADOS (ADMIN)
// ==========================================

app.get(
    "/api/admin/support/tickets",
    requireAdmin,
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    t.id,
                    t.access_code,
                    t.player_name,
                    t.subject,
                    t.status,
                    t.created_at,
                    t.updated_at,
                    (
                        SELECT COUNT(*)
                        FROM support_messages m
                        WHERE m.ticket_id = t.id
                    ) AS message_count
                FROM support_tickets t
                ORDER BY
                    CASE WHEN t.status = 'resolvido' THEN 1 ELSE 0 END,
                    t.updated_at DESC,
                    t.id DESC
            `);

            res.set("Cache-Control", "no-store");
            res.json(result.rows);
        } catch (error) {
            sendApiError(res, error);
        }
    }
);

// ==========================================
// SUPORTE — VER CONVERSA (ADMIN)
// ==========================================

app.get(
    "/api/admin/support/tickets/:id",
    requireAdmin,
    async (req, res) => {
        const id = req.params.id;

        if (!validNumericId(id)) {
            return res.status(400).json({
                error: true,
                message: "ID inválido."
            });
        }

        try {
            const result = await pool.query(
                `SELECT id, access_code, player_name, subject,
                        status, created_at, updated_at
                 FROM support_tickets
                 WHERE id = $1`,
                [id]
            );

            if (!result.rowCount) {
                return res.status(404).json({
                    error: true,
                    message: "Chamado não encontrado."
                });
            }

            const messages = await pool.query(
                `SELECT id, sender, message, created_at
                 FROM support_messages
                 WHERE ticket_id = $1
                 ORDER BY created_at ASC, id ASC`,
                [id]
            );

            res.set("Cache-Control", "no-store");

            res.json({
                ticket: result.rows[0],
                messages: messages.rows
            });
        } catch (error) {
            sendApiError(res, error);
        }
    }
);

// ==========================================
// SUPORTE — RESPOSTA DO ADMINISTRADOR
// ==========================================

app.post(
    "/api/admin/support/tickets/:id/messages",
    requireAdmin,
    async (req, res) => {
        const id = req.params.id;
        const message = cleanText(req.body?.message);

        if (!validNumericId(id)) {
            return res.status(400).json({
                error: true,
                message: "ID inválido."
            });
        }

        if (!message || message.length > 4000) {
            return res.status(400).json({
                error: true,
                message: "A resposta deve ter entre 1 e 4000 caracteres."
            });
        }

        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const result = await client.query(
                `SELECT id, status
                 FROM support_tickets
                 WHERE id = $1
                 FOR UPDATE`,
                [id]
            );

            if (!result.rowCount) {
                await client.query("ROLLBACK");

                return res.status(404).json({
                    error: true,
                    message: "Chamado não encontrado."
                });
            }

            if (result.rows[0].status === "resolvido") {
                await client.query("ROLLBACK");

                return res.status(409).json({
                    error: true,
                    message: "Reabra o chamado antes de responder."
                });
            }

            await client.query(
                `INSERT INTO support_messages (ticket_id, sender, message)
                 VALUES ($1, 'admin', $2)`,
                [id, message]
            );

            await client.query(
                `UPDATE support_tickets
                 SET status = 'atendimento', updated_at = NOW()
                 WHERE id = $1`,
                [id]
            );

            await client.query("COMMIT");
            res.status(201).json({ success: true });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            sendApiError(res, error);
        } finally {
            client.release();
        }
    }
);

// ==========================================
// SUPORTE — ALTERAR STATUS (ADMIN)
// ==========================================

app.patch(
    "/api/admin/support/tickets/:id",
    requireAdmin,
    async (req, res) => {
        const id = req.params.id;
        const status = req.body?.status;

        if (!validNumericId(id)) {
            return res.status(400).json({
                error: true,
                message: "ID inválido."
            });
        }

        if (!["aberto", "atendimento", "resolvido"].includes(status)) {
            return res.status(400).json({
                error: true,
                message: "Status inválido."
            });
        }

        try {
            const result = await pool.query(
                `UPDATE support_tickets
                 SET status = $1, updated_at = NOW()
                 WHERE id = $2
                 RETURNING id, status, updated_at`,
                [status, id]
            );

            if (!result.rowCount) {
                return res.status(404).json({
                    error: true,
                    message: "Chamado não encontrado."
                });
            }

            res.json({
                success: true,
                ticket: result.rows[0]
            });
        } catch (error) {
            sendApiError(res, error);
        }
    }
);

// ==========================================
// SUPORTE — EXCLUIR CHAMADO (ADMIN)
// ==========================================

app.delete(
    "/api/admin/support/tickets/:id",
    requireAdmin,
    async (req, res) => {
        const id = req.params.id;

        if (!validNumericId(id)) {
            return res.status(400).json({
                error: true,
                message: "ID inválido."
            });
        }

        try {
            const result = await pool.query(
                `DELETE FROM support_tickets
                 WHERE id = $1
                 RETURNING id`,
                [id]
            );

            if (!result.rowCount) {
                return res.status(404).json({
                    error: true,
                    message: "Chamado não encontrado."
                });
            }

            res.json({
                success: true,
                message: "Chamado excluído permanentemente."
            });
        } catch (error) {
            sendApiError(res, error);
        }
    }
);

// ==========================================
// AUTENTICAÇÃO DE CONTAS DA COMUNIDADE
// ==========================================

function requireAccount(req, res, next) {
    if (!req.session?.userId) {
        return res.status(401).json({ error: true, message: "Entre na sua conta para continuar." });
    }
    next();
}

async function loadAccount(req, res, next) {
    if (req.session?.isAdmin === true && !req.session?.userId) {
        req.account = { id: null, username: "Administrador", role: "admin", is_blocked: false };
        return next();
    }
    if (!req.session?.userId) return res.status(401).json({ error: true, message: "Entre na sua conta." });
    try {
        const result = await pool.query(
            "SELECT id, username, role, is_blocked FROM storm_users WHERE id = $1",
            [req.session.userId]
        );
        if (!result.rowCount || result.rows[0].is_blocked) {
            return res.status(403).json({ error: true, message: "Esta conta não pode acessar a plataforma." });
        }
        req.account = result.rows[0];
        next();
    } catch (error) { sendApiError(res, error); }
}

function requireNarrator(req, res, next) {
    if (req.account?.role === "narrator" || req.account?.role === "admin" || req.session?.isAdmin === true) return next();
    return res.status(403).json({ error: true, message: "Somente narradores podem realizar esta ação." });
}

function requirePlatformAdmin(req, res, next) {
    if (req.session?.isAdmin === true) return next();
    return res.status(403).json({ error: true, message: "Apenas o administrador da Academia Storm pode realizar esta ação." });
}

function slugify(value) {
    return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function saveSession(req) {
    return new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
}

app.post("/api/auth/register", async (req, res) => {
    const username = cleanText(req.body?.username);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
        return res.status(400).json({ error: true, message: "O usuário deve ter de 3 a 32 caracteres: letras, números ou _." });
    }
    if (password.length < 8 || password.length > 72) {
        return res.status(400).json({ error: true, message: "A senha deve ter entre 8 e 72 caracteres." });
    }
    try {
        const hash = await bcrypt.hash(password, 12);
        const result = await pool.query(
            `INSERT INTO storm_users (username, password_hash) VALUES ($1, $2)
             RETURNING id, username, role`, [username, hash]
        );
        req.session.regenerate(async error => {
            if (error) return res.status(500).json({ error: true, message: "Não foi possível iniciar sua sessão." });
            req.session.userId = result.rows[0].id;
            try { await saveSession(req); res.status(201).json({ success: true, user: result.rows[0] }); }
            catch { res.status(500).json({ error: true, message: "Não foi possível salvar sua sessão." }); }
        });
    } catch (error) {
        if (error.code === "23505") return res.status(409).json({ error: true, message: "Esse nome de usuário já está em uso." });
        sendApiError(res, error);
    }
});

app.post("/api/auth/login", async (req, res) => {
    const username = cleanText(req.body?.username);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    try {
        const result = await pool.query(
            "SELECT id, username, password_hash, role, is_blocked FROM storm_users WHERE LOWER(username) = LOWER($1)", [username]
        );
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ error: true, message: "Usuário ou senha incorretos." });
        }
        if (user.is_blocked) return res.status(403).json({ error: true, message: "Esta conta está bloqueada." });
        req.session.regenerate(error => {
            if (error) return res.status(500).json({ error: true, message: "Não foi possível iniciar sua sessão." });
            req.session.userId = user.id;
            req.session.save(saveError => {
                if (saveError) return res.status(500).json({ error: true, message: "Não foi possível salvar sua sessão." });
                res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
            });
        });
    } catch (error) { sendApiError(res, error); }
});

app.get("/api/auth/session", async (req, res) => {
    if (!req.session?.userId) return res.json({ authenticated: false });
    try {
        const result = await pool.query(
            "SELECT id, username, role, is_blocked FROM storm_users WHERE id = $1", [req.session.userId]
        );
        if (!result.rowCount || result.rows[0].is_blocked) return res.json({ authenticated: false });
        const { is_blocked, ...user } = result.rows[0];
        res.set("Cache-Control", "no-store").json({ authenticated: true, user });
    } catch (error) { sendApiError(res, error); }
});

app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(error => {
        if (error) return res.status(500).json({ error: true, message: "Não foi possível sair." });
        res.clearCookie("connect.sid", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" });
        res.json({ success: true });
    });
});

// ==========================================
// CANAIS
// ==========================================

app.get("/api/channels", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.id, c.title, c.slug, c.description, c.banner_url, c.avatar_url,
                   c.theme_bg, c.theme_panel, c.theme_primary, c.theme_text, c.visibility,
                   c.live_status, c.created_at, u.username AS narrator
            FROM storm_channels c JOIN storm_users u ON u.id = c.owner_user_id
            WHERE c.is_enabled = TRUE AND u.is_blocked = FALSE
              AND c.visibility = 'public'
            ORDER BY (c.live_status = 'live') DESC, c.created_at DESC
        `);
        res.set("Cache-Control", "no-store").json(result.rows);
    } catch (error) { sendApiError(res, error); }
});

app.get("/api/channels/:slug", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.id, c.title, c.slug, c.description, c.banner_url, c.avatar_url,
                   c.theme_bg, c.theme_panel, c.theme_primary, c.theme_text, c.visibility,
                   c.live_status, c.is_enabled, c.transmission_blocked,
                   c.owner_user_id, u.username AS narrator
            FROM storm_channels c JOIN storm_users u ON u.id = c.owner_user_id
            WHERE c.slug = $1
        `, [req.params.slug]);
        if (!result.rowCount) return res.status(404).json({ error: true, message: "Canal não encontrado." });
        const channel = result.rows[0];
        channel.is_owner = Number(req.session?.userId) === Number(channel.owner_user_id);
        if (!channel.is_enabled && !req.session?.isAdmin) return res.status(404).json({ error: true, message: "Canal indisponível." });
        if (channel.visibility === "private" && !req.session?.isAdmin && !req.session?.privateChannelAccess?.[String(channel.id)]) {
            const safe = { ...channel, private: true };
            delete safe.owner_user_id; delete safe.transmission_blocked; delete safe.is_enabled;
            return res.json({ ...safe, access_required: true });
        }
        delete channel.owner_user_id;
        delete channel.transmission_blocked;
        delete channel.is_enabled;
        res.json(channel);
    } catch (error) { sendApiError(res, error); }
});

app.post("/api/channels", loadAccount, requireNarrator, async (req, res) => {
    const title = cleanText(req.body?.title);
    const description = cleanText(req.body?.description).slice(0, 500);
    const visibility = req.body?.visibility === "private" ? "private" : "public";
    const accessCode = typeof req.body?.access_code === "string" ? req.body.access_code : "";
    if (title.length < 3 || title.length > 80) return res.status(400).json({ error: true, message: "O nome do canal deve ter entre 3 e 80 caracteres." });
    if (visibility === "private" && accessCode.length < 4) return res.status(400).json({ error: true, message: "Canais privados precisam de um código com pelo menos 4 caracteres." });
    try {
        let ownerId = req.account.id;
        if (req.account.role === "admin" && req.body?.narrator_id) {
            const narrator = await pool.query("SELECT id FROM storm_users WHERE id = $1 AND role = 'narrator' AND is_blocked = FALSE", [req.body.narrator_id]);
            if (!narrator.rowCount) return res.status(400).json({ error: true, message: "Selecione uma conta ativa com função de narrador." });
            ownerId = narrator.rows[0].id;
        }
        if (!ownerId) return res.status(400).json({ error: true, message: "Informe o ID de uma conta de narrador para criar o canal." });
        let slug = slugify(title) || "canal";
        slug += "-" + crypto.randomBytes(3).toString("hex");
        const codeHash = visibility === "private" ? await bcrypt.hash(accessCode, 12) : null;
        const result = await pool.query(`
            INSERT INTO storm_channels (owner_user_id, title, slug, description, visibility, access_code_hash)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, title, slug, description, visibility, created_at
        `, [ownerId, title, slug, description, visibility, codeHash]);
        res.status(201).json({ success: true, channel: result.rows[0] });
    } catch (error) { sendApiError(res, error); }
});

app.patch("/api/channels/:id", loadAccount, async (req, res) => {
    const id = req.params.id;
    if (!validNumericId(id)) return res.status(400).json({ error: true, message: "Canal inválido." });
    try {
        const current = await pool.query("SELECT * FROM storm_channels WHERE id = $1", [id]);
        if (!current.rowCount) return res.status(404).json({ error: true, message: "Canal não encontrado." });
        if (req.account.role !== "admin" && (Number(current.rows[0].owner_user_id) !== Number(req.account.id) || req.account.role !== "narrator")) {
            return res.status(403).json({ error: true, message: "Somente o narrador responsável pode editar este canal." });
        }
        const old = current.rows[0];
        const title = req.body?.title === undefined ? old.title : cleanText(req.body.title);
        const description = req.body?.description === undefined ? old.description : cleanText(req.body.description).slice(0, 500);
        const visibility = ["private", "public"].includes(req.body?.visibility) ? req.body.visibility : old.visibility;
        const color = (value, fallback) => typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
        const themeBg = color(req.body?.theme_bg, old.theme_bg || "#050f1d");
        const themePanel = color(req.body?.theme_panel, old.theme_panel || "#0c1d30");
        const themePrimary = color(req.body?.theme_primary, old.theme_primary || "#5bbcff");
        const themeText = color(req.body?.theme_text, old.theme_text || "#eaf4ff");
        let codeHash = old.access_code_hash;
        if (visibility === "private" && req.body?.access_code) {
            if (String(req.body.access_code).length < 4) return res.status(400).json({ error: true, message: "O código deve ter pelo menos 4 caracteres." });
            codeHash = await bcrypt.hash(String(req.body.access_code), 12);
        }
        if (visibility === "private" && !codeHash) return res.status(400).json({ error: true, message: "Defina um código de acesso para o canal privado." });
        if (title.length < 3 || title.length > 80) return res.status(400).json({ error: true, message: "O nome deve ter entre 3 e 80 caracteres." });
        const updated = await pool.query(`
            UPDATE storm_channels SET title = $1, description = $2, visibility = $3,
                access_code_hash = $4, theme_bg = $5, theme_panel = $6,
                theme_primary = $7, theme_text = $8, updated_at = NOW()
            WHERE id = $9
            RETURNING id, title, slug, description, visibility, live_status,
                      banner_url, avatar_url, theme_bg, theme_panel, theme_primary, theme_text
        `, [title, description, visibility, codeHash, themeBg, themePanel, themePrimary, themeText, id]);
        res.json({ success: true, channel: updated.rows[0] });
    } catch (error) { sendApiError(res, error); }
});

// Upload de avatar e banner do canal (somente narrador responsável ou administrador).
app.post("/api/channels/:id/assets/:assetType", loadAccount, (req, res, next) => {
    imageUpload.single("image")(req, res, error => {
        if (error) return res.status(400).json({ error: true, message: error.message || "Não foi possível receber a imagem." });
        next();
    });
}, async (req, res) => {
    const { id, assetType } = req.params;
    if (!validNumericId(id) || !["avatar", "banner"].includes(assetType)) {
        return res.status(400).json({ error: true, message: "Destino de imagem inválido." });
    }
    if (!req.file) return res.status(400).json({ error: true, message: "Selecione uma imagem JPG, PNG, WEBP ou GIF." });
    try {
        const channelResult = await pool.query("SELECT id, owner_user_id FROM storm_channels WHERE id = $1", [id]);
        if (!channelResult.rowCount) return res.status(404).json({ error: true, message: "Canal não encontrado." });
        const ownerId = Number(channelResult.rows[0].owner_user_id);
        if (req.account.role !== "admin" && (ownerId !== Number(req.account.id) || req.account.role !== "narrator")) {
            return res.status(403).json({ error: true, message: "Somente o narrador responsável pode alterar as imagens." });
        }
        if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
            return res.status(503).json({ error: true, message: "Configure as variáveis do Cloudinary no Render para enviar imagens." });
        }
        const uploaded = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream({
                folder: "academia-storm/channels/" + id,
                resource_type: "image",
                transformation: assetType === "avatar"
                    ? [{ width: 600, height: 600, crop: "fill", gravity: "auto", quality: "auto", fetch_format: "auto" }]
                    : [{ width: 1800, height: 600, crop: "limit", quality: "auto", fetch_format: "auto" }]
            }, (error, result) => error ? reject(error) : resolve(result));
            stream.end(req.file.buffer);
        });
        const column = assetType === "avatar" ? "avatar_url" : "banner_url";
        const update = await pool.query(`UPDATE storm_channels SET ${column} = $1, updated_at = NOW() WHERE id = $2 RETURNING id, avatar_url, banner_url`, [uploaded.secure_url, id]);
        res.json({ success: true, asset_type: assetType, channel: update.rows[0] });
    } catch (error) { sendApiError(res, error); }
});

app.post("/api/channels/:id/access", async (req, res) => {
    const code = typeof req.body?.access_code === "string" ? req.body.access_code : "";
    try {
        const result = await pool.query("SELECT id, access_code_hash, is_enabled FROM storm_channels WHERE id = $1 AND visibility = 'private'", [req.params.id]);
        if (!result.rowCount || !result.rows[0].is_enabled || !(await bcrypt.compare(code, result.rows[0].access_code_hash))) {
            return res.status(403).json({ error: true, message: "Código incorreto ou canal indisponível." });
        }
        req.session.privateChannelAccess = req.session.privateChannelAccess || {};
        req.session.privateChannelAccess[String(req.params.id)] = true;
        await saveSession(req);
        res.json({ success: true, access_granted: true });
    } catch (error) { sendApiError(res, error); }
});

// ==========================================
// NARRADORES E MODERADORES
// ==========================================

app.post("/api/channels/:id/moderator-requests", loadAccount, async (req, res) => {
    const username = cleanText(req.body?.username);
    try {
        const channelResult = await pool.query("SELECT id, owner_user_id FROM storm_channels WHERE id = $1", [req.params.id]);
        if (!channelResult.rowCount || Number(channelResult.rows[0].owner_user_id) !== Number(req.account.id) || req.account.role !== "narrator") return res.status(403).json({ error: true, message: "Somente o narrador do canal pode indicar moderadores." });
        const target = await pool.query("SELECT id, username FROM storm_users WHERE LOWER(username) = LOWER($1) AND is_blocked = FALSE", [username]);
        if (!target.rowCount) return res.status(404).json({ error: true, message: "Usuário não encontrado." });
        const result = await pool.query(`
            INSERT INTO storm_channel_moderators (channel_id, user_id, requested_by)
            VALUES ($1, $2, $3)
            ON CONFLICT (channel_id, user_id) DO UPDATE SET
                request_status = 'pending', requested_by = EXCLUDED.requested_by,
                reviewed_by = NULL, reviewed_at = NULL
            RETURNING id, request_status
        `, [req.params.id, target.rows[0].id, req.account.id]);
        res.status(201).json({ success: true, request: result.rows[0], message: "Indicação enviada para aprovação do administrador." });
    } catch (error) { sendApiError(res, error); }
});

app.get("/api/admin/platform/users", requireAdmin, async (req, res) => {
    try {
        const result = await pool.query("SELECT id, username, role, is_blocked, created_at FROM storm_users ORDER BY created_at DESC LIMIT 500");
        res.json(result.rows);
    } catch (error) { sendApiError(res, error); }
});

app.patch("/api/admin/platform/users/:id", requireAdmin, async (req, res) => {
    const role = req.body?.role;
    const blocked = req.body?.is_blocked;
    if (role !== undefined && !["viewer", "narrator"].includes(role)) return res.status(400).json({ error: true, message: "Função inválida." });
    if (blocked !== undefined && typeof blocked !== "boolean") return res.status(400).json({ error: true, message: "Estado de bloqueio inválido." });
    try {
        const result = await pool.query(`
            UPDATE storm_users SET role = COALESCE($1, role),
                is_blocked = COALESCE($2, is_blocked), updated_at = NOW()
            WHERE id = $3 RETURNING id, username, role, is_blocked
        `, [role ?? null, blocked ?? null, req.params.id]);
        if (!result.rowCount) return res.status(404).json({ error: true, message: "Usuário não encontrado." });
        if (result.rows[0].is_blocked || result.rows[0].role === "viewer") {
            const owned = await pool.query("SELECT id FROM storm_channels WHERE owner_user_id = $1 AND live_status = 'live'", [req.params.id]);
            for (const channel of owned.rows) await stopChannelLive(channel.id, req.session.userId || null);
        }
        res.json({ success: true, user: result.rows[0] });
    } catch (error) { sendApiError(res, error); }
});

app.get("/api/admin/platform/channels", requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.id, c.owner_user_id, c.title, c.slug, c.description, c.banner_url,
                   c.visibility, c.is_enabled, c.transmission_blocked, c.live_status,
                   c.created_at, u.username AS narrator
            FROM storm_channels c JOIN storm_users u ON u.id = c.owner_user_id
            ORDER BY c.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) { sendApiError(res, error); }
});

app.patch("/api/admin/platform/channels/:id", requireAdmin, async (req, res) => {
    const enabled = req.body?.is_enabled;
    const blocked = req.body?.transmission_blocked;
    if (enabled !== undefined && typeof enabled !== "boolean") return res.status(400).json({ error: true, message: "Estado do canal inválido." });
    if (blocked !== undefined && typeof blocked !== "boolean") return res.status(400).json({ error: true, message: "Estado da transmissão inválido." });
    try {
        const result = await pool.query(`
            UPDATE storm_channels SET is_enabled = COALESCE($1, is_enabled),
                transmission_blocked = COALESCE($2, transmission_blocked), updated_at = NOW()
            WHERE id = $3 RETURNING id, is_enabled, transmission_blocked, live_status
        `, [enabled ?? null, blocked ?? null, req.params.id]);
        if (!result.rowCount) return res.status(404).json({ error: true, message: "Canal não encontrado." });
        if (blocked === true || enabled === false) await stopChannelLive(req.params.id, req.session.userId || null);
        res.json({ success: true, channel: result.rows[0] });
    } catch (error) { sendApiError(res, error); }
});

app.get("/api/admin/platform/moderator-requests", requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT m.id, m.channel_id, c.title AS channel_title, u.id AS user_id,
                   u.username, m.request_status, requester.username AS requested_by,
                   m.created_at
            FROM storm_channel_moderators m
            JOIN storm_channels c ON c.id = m.channel_id
            JOIN storm_users u ON u.id = m.user_id
            LEFT JOIN storm_users requester ON requester.id = m.requested_by
            WHERE m.request_status = 'pending' ORDER BY m.created_at ASC
        `);
        res.json(result.rows);
    } catch (error) { sendApiError(res, error); }
});

app.patch("/api/admin/platform/moderator-requests/:id", requireAdmin, async (req, res) => {
    const decision = req.body?.decision;
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: true, message: "Decisão inválida." });
    try {
        const result = await pool.query(`
            UPDATE storm_channel_moderators SET request_status = $1,
                reviewed_by = (SELECT id FROM storm_users WHERE id = $2), reviewed_at = NOW()
            WHERE id = $3 AND request_status = 'pending'
            RETURNING id, channel_id, user_id, request_status
        `, [decision, req.session.userId || null, req.params.id]);
        if (!result.rowCount) return res.status(404).json({ error: true, message: "Indicação não encontrada ou já analisada." });
        res.json({ success: true, request: result.rows[0] });
    } catch (error) { sendApiError(res, error); }
});

app.get("/api/channels/:id/moderators", loadAccount, async (req, res) => {
    try {
        const owner = await pool.query("SELECT owner_user_id FROM storm_channels WHERE id = $1", [req.params.id]);
        if (!owner.rowCount) return res.status(404).json({ error: true, message: "Canal não encontrado." });
        if (req.account.role !== "admin" && Number(owner.rows[0].owner_user_id) !== Number(req.account.id)) return res.status(403).json({ error: true, message: "Somente o narrador pode consultar a equipe de moderação." });
        const result = await pool.query(`
            SELECT m.id, u.id AS user_id, u.username, m.request_status, m.created_at, m.reviewed_at
            FROM storm_channel_moderators m JOIN storm_users u ON u.id = m.user_id
            WHERE m.channel_id = $1 ORDER BY m.created_at DESC
        `, [req.params.id]);
        res.json(result.rows);
    } catch (error) { sendApiError(res, error); }
});

app.delete("/api/channels/:id/moderators/:userId", loadAccount, async (req, res) => {
    try {
        const owner = await pool.query("SELECT owner_user_id FROM storm_channels WHERE id = $1", [req.params.id]);
        if (!owner.rowCount) return res.status(404).json({ error: true, message: "Canal não encontrado." });
        if (req.account.role !== "admin" && (Number(owner.rows[0].owner_user_id) !== Number(req.account.id) || req.account.role !== "narrator")) return res.status(403).json({ error: true, message: "Somente o narrador pode remover moderadores deste canal." });
        await pool.query("DELETE FROM storm_channel_moderators WHERE channel_id = $1 AND user_id = $2", [req.params.id, req.params.userId]);
        res.json({ success: true });
    } catch (error) { sendApiError(res, error); }
});

app.get("/api/channels/:id/live-history", async (req, res) => {
    try {
        const channel = await pool.query("SELECT visibility FROM storm_channels WHERE id = $1 AND is_enabled = TRUE", [req.params.id]);
        if (!channel.rowCount) return res.status(404).json({ error: true, message: "Canal indisponível." });
        if (channel.rows[0].visibility === "private" && !req.session?.privateChannelAccess?.[String(req.params.id)] && !req.session?.isAdmin) return res.status(403).json({ error: true, message: "Acesso ao canal privado necessário." });
        const history = await pool.query(`SELECT started_at, ended_at FROM storm_live_sessions WHERE channel_id = $1 ORDER BY started_at DESC LIMIT 30`, [req.params.id]);
        res.json(history.rows);
    } catch (error) { sendApiError(res, error); }
});

// ==========================================
// LIVEKIT: INÍCIO, TOKEN E ENCERRAMENTO
// ==========================================

function getLiveKitRoomService() {
    const host = process.env.LIVEKIT_URL;
    const key = process.env.LIVEKIT_API_KEY;
    const secret = process.env.LIVEKIT_API_SECRET;
    if (!host || !key || !secret) throw new Error("Configure LIVEKIT_URL, LIVEKIT_API_KEY e LIVEKIT_API_SECRET no Render.");
    const httpHost = host.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
    return new RoomServiceClient(httpHost, key, secret);
}

async function stopChannelLive(channelId, endedBy) {
    const current = await pool.query(
        "SELECT live_room_name FROM storm_channels WHERE id = $1",
        [channelId]
    );
    if (!current.rowCount) return;

    const roomName = current.rows[0].live_room_name;

    // A sala pode já ter sido removida no LiveKit; isso não impede a limpeza do banco.
    if (
        roomName &&
        process.env.LIVEKIT_URL &&
        process.env.LIVEKIT_API_KEY &&
        process.env.LIVEKIT_API_SECRET
    ) {
        try {
            await getLiveKitRoomService().deleteRoom(roomName);
        } catch (error) {
            console.warn("Sala LiveKit já encerrada ou indisponível:", error.message);
        }
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(
            `UPDATE storm_live_sessions
             SET ended_at = NOW(), ended_by = $1
             WHERE channel_id = $2 AND ended_at IS NULL`,
            [endedBy, channelId]
        );
        await client.query(
            `UPDATE storm_channels
             SET live_status = 'offline',
                 live_room_name = NULL,
                 live_heartbeat_at = NULL,
                 updated_at = NOW()
             WHERE id = $1`,
            [channelId]
        );
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }

    io.to("channel:" + channelId).emit("live:ended", {
        channel_id: Number(channelId)
    });
    io.to("channels").emit("channel:updated", {
        channel_id: Number(channelId),
        live_status: "offline"
    });
}

app.post("/api/channels/:id/live/start", loadAccount, async (req, res) => {
    let client;
    try {
        // Valida as credenciais antes de alterar qualquer estado no banco.
        getLiveKitRoomService();

        client = await pool.connect();
        await client.query("BEGIN");

        // O bloqueio impede duas tentativas simultâneas para o mesmo canal.
        const result = await client.query(
            "SELECT * FROM storm_channels WHERE id = $1 FOR UPDATE",
            [req.params.id]
        );

        if (!result.rowCount) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: true, message: "Canal não encontrado." });
        }

        const channel = result.rows[0];

        if (
            req.account.role !== "admin" &&
            (Number(channel.owner_user_id) !== Number(req.account.id) ||
             req.account.role !== "narrator")
        ) {
            await client.query("ROLLBACK");
            return res.status(403).json({ error: true, message: "Somente o narrador deste canal pode transmitir." });
        }
        if (!channel.is_enabled) {
            await client.query("ROLLBACK");
            return res.status(403).json({ error: true, message: "Este canal está desativado." });
        }
        if (channel.transmission_blocked || req.account.is_blocked) {
            await client.query("ROLLBACK");
            return res.status(403).json({ error: true, message: "A transmissão deste canal está bloqueada." });
        }

        const activeSession = await client.query(
            `SELECT id FROM storm_live_sessions
             WHERE channel_id = $1 AND ended_at IS NULL
             LIMIT 1`,
            [channel.id]
        );

        if (activeSession.rowCount) {
            await client.query("ROLLBACK");
            return res.status(409).json({ error: true, message: "Este canal já possui uma transmissão ativa." });
        }

        const roomName = "storm-channel-" + channel.id;

        // A sessão e o status do canal são gravados na mesma transação.
        await client.query(
            `INSERT INTO storm_live_sessions (channel_id, room_name)
             VALUES ($1, $2)`,
            [channel.id, roomName]
        );
        await client.query(
            `UPDATE storm_channels
             SET live_status = 'live',
                 live_room_name = $1,
                 live_heartbeat_at = NOW(),
                 updated_at = NOW()
             WHERE id = $2`,
            [roomName, channel.id]
        );

        await client.query("COMMIT");

        io.to("channels").emit("channel:updated", {
            channel_id: Number(channel.id),
            live_status: "live"
        });
        return res.json({ success: true, live_status: "live", room_name: roomName });
    } catch (error) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        return sendApiError(res, error);
    } finally {
        if (client) client.release();
    }
});

app.post("/api/channels/:id/live/stop", loadAccount, async (req, res) => {
    try {
        const result = await pool.query("SELECT owner_user_id FROM storm_channels WHERE id = $1", [req.params.id]);
        if (!result.rowCount) return res.status(404).json({ error: true, message: "Canal não encontrado." });
        if (Number(result.rows[0].owner_user_id) !== Number(req.account.id) && req.account.role !== "admin") return res.status(403).json({ error: true, message: "Você não pode encerrar esta transmissão." });
        await stopChannelLive(req.params.id, req.account.id);
        res.json({ success: true, live_status: "offline" });
    } catch (error) { sendApiError(res, error); }
});

app.post("/api/channels/:id/live/heartbeat", loadAccount, async (req, res) => {
    try {
        const result = await pool.query("SELECT owner_user_id, live_status FROM storm_channels WHERE id = $1", [req.params.id]);
        if (!result.rowCount) return res.status(404).json({ error: true, message: "Canal não encontrado." });
        if (Number(result.rows[0].owner_user_id) !== Number(req.account.id) && req.account.role !== "admin") {
            return res.status(403).json({ error: true, message: "Somente o responsável pode manter esta transmissão ativa." });
        }
        if (result.rows[0].live_status !== "live") return res.status(409).json({ error: true, message: "A transmissão não está ativa." });
        await pool.query("UPDATE storm_channels SET live_heartbeat_at = NOW() WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (error) { sendApiError(res, error); }
});

app.post("/api/admin/platform/channels/:id/live/stop", requireAdmin, async (req, res) => {
    try { await stopChannelLive(req.params.id, req.session.userId || null); res.json({ success: true, live_status: "offline" }); }
    catch (error) { sendApiError(res, error); }
});

app.post("/api/channels/:id/live-token", async (req, res) => {
    const channelId = req.params.id;
    try {
        const result = await pool.query(`
            SELECT c.*, u.is_blocked AS owner_blocked FROM storm_channels c
            JOIN storm_users u ON u.id = c.owner_user_id WHERE c.id = $1
        `, [channelId]);
        if (!result.rowCount) return res.status(404).json({ error: true, message: "Canal não encontrado." });
        const channel = result.rows[0];
        if (!channel.is_enabled || channel.live_status !== "live" || !channel.live_room_name) return res.status(409).json({ error: true, message: "Este canal não está ao vivo." });
        if (channel.visibility === "private" && !req.session?.isAdmin && !req.session?.privateChannelAccess?.[String(channelId)]) {
            return res.status(403).json({ error: true, message: "Informe o código de acesso do canal privado." });
        }
        const isOwner = Number(req.session?.userId) === Number(channel.owner_user_id);
        let accountRole = null;
        if (req.session?.userId) {
            const account = await pool.query("SELECT role, is_blocked FROM storm_users WHERE id = $1", [req.session.userId]);
            if (account.rowCount && account.rows[0].is_blocked) return res.status(403).json({ error: true, message: "Esta conta está bloqueada." });
            if (account.rowCount) accountRole = account.rows[0].role;
        }
        const isAdmin = req.session?.isAdmin === true || accountRole === "admin";
        const isPublisher = ((isOwner && !channel.owner_blocked) || isAdmin) && !channel.transmission_blocked;
        const identity = req.session?.userId ? "user-" + req.session.userId : "guest-" + crypto.randomBytes(8).toString("hex");
        const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity, ttl: "2h" });
        token.addGrant({ roomJoin: true, room: channel.live_room_name, canPublish: isPublisher, canSubscribe: true });
        res.json({ token: await token.toJwt(), server_url: process.env.LIVEKIT_URL, can_publish: isPublisher });
    } catch (error) { sendApiError(res, error); }
});

// ==========================================
// CHAT, COMENTÁRIOS E MODERAÇÃO POR CANAL
// ==========================================

async function channelModerator(channelId, userId) {
    const result = await pool.query(`SELECT 1 FROM storm_channel_moderators WHERE channel_id = $1 AND user_id = $2 AND request_status = 'approved'`, [channelId, userId]);
    return result.rowCount > 0;
}

app.get("/api/channels/:id/permissions", async (req, res) => {
    if (!req.session?.userId && !req.session?.isAdmin) return res.json({ authenticated: false, can_moderate: false, is_owner: false });
    try {
        const channel = await pool.query("SELECT owner_user_id FROM storm_channels WHERE id = $1", [req.params.id]);
        if (!channel.rowCount) return res.status(404).json({ error: true, message: "Canal não encontrado." });
        const userId = req.session?.userId;
        const isOwner = Number(userId) === Number(channel.rows[0].owner_user_id);
        const isMod = userId ? await channelModerator(req.params.id, userId) : false;
        res.json({ authenticated: true, is_owner: isOwner, can_moderate: Boolean(isOwner || isMod || req.session?.isAdmin) });
    } catch (error) { sendApiError(res, error); }
});

app.get("/api/channels/:id/comments", async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    try {
        const channel = await pool.query("SELECT visibility FROM storm_channels WHERE id = $1 AND is_enabled = TRUE", [req.params.id]);
        if (!channel.rowCount) return res.status(404).json({ error: true, message: "Canal indisponível." });
        if (channel.rows[0].visibility === "private" && !req.session?.privateChannelAccess?.[String(req.params.id)] && !req.session?.isAdmin) return res.status(403).json({ error: true, message: "Acesso ao canal privado necessário." });
        const comments = await pool.query(`SELECT id, user_id, username, message, created_at FROM storm_channel_comments WHERE channel_id = $1 ORDER BY created_at DESC LIMIT $2`, [req.params.id, limit]);
        res.json(comments.rows.reverse());
    } catch (error) { sendApiError(res, error); }
});

app.post("/api/channels/:id/comments", loadAccount, async (req, res) => {
    const message = cleanText(req.body?.message);
    if (message.length < 1 || message.length > 1000) return res.status(400).json({ error: true, message: "O comentário deve ter entre 1 e 1000 caracteres." });
    try {
        const channel = await pool.query("SELECT visibility, is_enabled FROM storm_channels WHERE id = $1", [req.params.id]);
        if (!channel.rowCount || !channel.rows[0].is_enabled) return res.status(404).json({ error: true, message: "Canal indisponível." });
        if (channel.rows[0].visibility === "private" && !req.session?.privateChannelAccess?.[String(req.params.id)]) return res.status(403).json({ error: true, message: "Acesso ao canal privado necessário." });
        const action = await pool.query(`SELECT action_type, expires_at FROM storm_channel_user_actions WHERE channel_id = $1 AND user_id = $2`, [req.params.id, req.account.id]);
        if (action.rowCount && (action.rows[0].action_type === "ban" || (action.rows[0].action_type === "timeout" && action.rows[0].expires_at && new Date(action.rows[0].expires_at) > new Date()))) return res.status(403).json({ error: true, message: "Você está impedido de comentar neste canal." });
        const recent = await pool.query(`SELECT message, created_at FROM storm_channel_comments WHERE channel_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`, [req.params.id, req.account.id]);
        if (recent.rowCount && recent.rows[0].message === message) return res.status(429).json({ error: true, message: "Evite enviar a mesma mensagem repetidamente." });
        if (recent.rowCount && Date.now() - new Date(recent.rows[0].created_at).getTime() < 1200) return res.status(429).json({ error: true, message: "Aguarde um instante antes de enviar outra mensagem." });
        const result = await pool.query(`INSERT INTO storm_channel_comments (channel_id, user_id, username, message) VALUES ($1, $2, $3, $4) RETURNING id, username, message, created_at`, [req.params.id, req.account.id, req.account.username, message]);
        io.to("channel:" + req.params.id).emit("comment:new", result.rows[0]);
        res.status(201).json({ success: true, comment: result.rows[0] });
    } catch (error) { sendApiError(res, error); }
});

app.delete("/api/channels/:channelId/comments/:commentId", loadAccount, async (req, res) => {
    try {
        const comment = await pool.query("SELECT id, user_id FROM storm_channel_comments WHERE id = $1 AND channel_id = $2", [req.params.commentId, req.params.channelId]);
        if (!comment.rowCount) return res.status(404).json({ error: true, message: "Comentário não encontrado." });
        const isAdmin = req.session?.isAdmin === true || req.account.role === "admin";
        const isOwner = await pool.query("SELECT 1 FROM storm_channels WHERE id = $1 AND owner_user_id = $2", [req.params.channelId, req.account.id]);
        const isMod = await channelModerator(req.params.channelId, req.account.id);
        if (!isAdmin && !isOwner.rowCount && !isMod) return res.status(403).json({ error: true, message: "Você não tem permissão para moderar este canal." });
        await pool.query("DELETE FROM storm_channel_comments WHERE id = $1", [req.params.commentId]);
        io.to("channel:" + req.params.channelId).emit("comment:deleted", { id: Number(req.params.commentId) });
        res.json({ success: true });
    } catch (error) { sendApiError(res, error); }
});

app.post("/api/channels/:channelId/moderation/:userId", loadAccount, async (req, res) => {
    const type = req.body?.action_type;
    const minutes = Math.min(Math.max(Number(req.body?.minutes) || 10, 1), 10080);
    if (!['timeout', 'ban'].includes(type)) return res.status(400).json({ error: true, message: "Ação inválida." });
    try {
        const isAdmin = req.session?.isAdmin === true || req.account.role === "admin";
        const owner = await pool.query("SELECT 1 FROM storm_channels WHERE id = $1 AND owner_user_id = $2", [req.params.channelId, req.account.id]);
        const isMod = await channelModerator(req.params.channelId, req.account.id);
        if (!isAdmin && !owner.rowCount && !isMod) return res.status(403).json({ error: true, message: "Você não tem permissão para moderar este canal." });
        if (!isAdmin && !owner.rowCount) {
            const protectedTarget = await pool.query(`
                SELECT 1 FROM storm_channels WHERE id = $1 AND owner_user_id = $2
                UNION ALL
                SELECT 1 FROM storm_channel_moderators WHERE channel_id = $1 AND user_id = $2 AND request_status = 'approved'
                UNION ALL
                SELECT 1 FROM storm_users WHERE id = $2 AND role = 'admin'
                LIMIT 1
            `, [req.params.channelId, req.params.userId]);
            if (protectedTarget.rowCount) return res.status(403).json({ error: true, message: "Moderadores não podem aplicar punições ao narrador, a outros moderadores ou a administradores." });
        }
        const expires = type === "timeout" ? new Date(Date.now() + minutes * 60000) : null;
        await pool.query(`INSERT INTO storm_channel_user_actions (channel_id, user_id, action_type, expires_at, created_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (channel_id, user_id) DO UPDATE SET action_type = EXCLUDED.action_type, expires_at = EXCLUDED.expires_at, created_by = EXCLUDED.created_by, created_at = NOW()`, [req.params.channelId, req.params.userId, type, expires, req.account.id]);
        res.json({ success: true, action_type: type, expires_at: expires });
    } catch (error) { sendApiError(res, error); }
});

app.delete("/api/channels/:channelId/moderation/:userId", loadAccount, async (req, res) => {
    try {
        const isAdmin = req.session?.isAdmin === true || req.account.role === "admin";
        const owner = await pool.query("SELECT 1 FROM storm_channels WHERE id = $1 AND owner_user_id = $2", [req.params.channelId, req.account.id]);
        const isMod = await channelModerator(req.params.channelId, req.account.id);
        if (!isAdmin && !owner.rowCount && !isMod) return res.status(403).json({ error: true, message: "Você não tem permissão para moderar este canal." });
        await pool.query("DELETE FROM storm_channel_user_actions WHERE channel_id = $1 AND user_id = $2", [req.params.channelId, req.params.userId]);
        res.json({ success: true });
    } catch (error) { sendApiError(res, error); }
});

// ==========================================
// SOCKET.IO — EVENTOS EM TEMPO REAL
// ==========================================

const server = http.createServer(app);
const io = new Server(server, { serveClient: true });
io.engine.use(sessionMiddleware);
io.on("connection", socket => {
    socket.on("channel:join", async ({ channelId, accessCode } = {}, callback = () => {}) => {
        try {
            const result = await pool.query("SELECT visibility, access_code_hash, is_enabled FROM storm_channels WHERE id = $1", [channelId]);
            if (!result.rowCount || !result.rows[0].is_enabled) return callback({ error: "Canal indisponível." });
            if (result.rows[0].visibility === "private") {
                const sessionAccess = socket.request.session?.privateChannelAccess?.[String(channelId)];
                const validCode = accessCode && await bcrypt.compare(String(accessCode), result.rows[0].access_code_hash);
                if (!sessionAccess && !validCode && !socket.request.session?.isAdmin) return callback({ error: "Código de acesso necessário." });
            }
            socket.join("channel:" + channelId);
            callback({ success: true });
        } catch { callback({ error: "Não foi possível entrar no canal." }); }
    });
    socket.on("channels:subscribe", () => socket.join("channels"));
});

// Encerra transmissões abandonadas quando o navegador do narrador perde conexão.
setInterval(async () => {
    try {
        const stale = await pool.query(`
            SELECT c.id, s.started_at
            FROM storm_channels c
            LEFT JOIN LATERAL (
                SELECT started_at FROM storm_live_sessions
                WHERE channel_id = c.id AND ended_at IS NULL
                ORDER BY started_at DESC LIMIT 1
            ) s ON TRUE
            WHERE c.live_status = 'live'
              AND COALESCE(c.live_heartbeat_at, s.started_at) < NOW() - INTERVAL '100 seconds'
        `);
        for (const channel of stale.rows) {
            console.warn("Encerrando transmissão sem sinal do narrador no canal", channel.id);
            await stopChannelLive(channel.id, null);
        }
    } catch (error) {
        console.error("Falha ao verificar transmissões abandonadas:", error.message);
    }
}, 30000).unref?.();

// ==========================================
// PÁGINAS DO SITE
// ==========================================

app.get("/transmissoes", (req, res) => {
    res.sendFile(path.join(__dirname, "transmissoes.html"));
});

app.get("/canal/:slug", (req, res) => {
    res.sendFile(path.join(__dirname, "canal.html"));
});

app.get("/conta", (req, res) => {
    res.sendFile(path.join(__dirname, "conta.html"));
});

app.get("/admin-plataforma", (req, res) => {
    res.sendFile(path.join(__dirname, "admin-plataforma.html"));
});

app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/suporte", (req, res) => {
    res.sendFile(path.join(__dirname, "suporte.html"));
});

app.get("/admin-suporte", (req, res) => {
    res.sendFile(path.join(__dirname, "admin-suporte.html"));
});

app.get("/{*splat}", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// ==========================================
// INICIALIZAÇÃO DO SERVIDOR
// ==========================================

async function startServer() {
    await createPlayerPhotosTable();
    await createSupportTables();
    await createLivePlatformTables();

    server.listen(PORT, () => {
        console.log("Academia Storm iniciada na porta " + PORT);
        console.log("Scoreboards board: " + BOARD_ID);
        console.log("PostgreSQL conectado.");
        console.log("Tabela de fotos verificada.");
        console.log("Tabelas do suporte verificadas.");
        console.log("Contas, canais e recursos de transmissão verificados.");
    });
}

startServer().catch(error => {
    console.error("Falha ao iniciar o servidor:", error);
    process.exit(1);
});