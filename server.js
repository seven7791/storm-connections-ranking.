require("dotenv").config();

const express = require("express");
const path = require("path");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 3000;
const BOARD_ID = "754526789448";
const SCOREBOARDS_API_KEY = process.env.SCOREBOARDS_API_KEY;

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL não configurada.");
}

if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    throw new Error("ADMIN_USERNAME e ADMIN_PASSWORD precisam estar configuradas.");
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

app.set("trust proxy", 1);
app.use(express.json({ limit: "20kb" }));

app.use(session({
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
}));

app.use(express.static(__dirname));

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
// SCOREBOARDS.DEV — ROTAS EXISTENTES
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
        console.error("ERRO SCOREBOARDS:", response.status, text);
        throw error;
    }

    try {
        return text ? JSON.parse(text) : {};
    } catch {
        throw new Error("Resposta inválida do Scoreboards.");
    }
}

app.get("/api/ranking", async (req, res) => {
    try {
        const limit = Math.min(
            Math.max(Number(req.query.limit) || 200, 1),
            200
        );

        const data = await scoreboardsFetch(
            "/boards/" + encodeURIComponent(BOARD_ID) +
            "/entries?limit=" + limit
        );

        res.json(data);
    } catch (error) {
        sendApiError(res, error);
    }
});

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

app.get("/api/player/:playerId", async (req, res) => {
    try {
        const data = await scoreboardsFetch(
            "/boards/" + encodeURIComponent(BOARD_ID) +
            "/entries/" + encodeURIComponent(req.params.playerId)
        );

        res.json(data);
    } catch (error) {
        sendApiError(res, error);
    }
});

// ==========================================
// LOGIN ADMINISTRATIVO EXISTENTE
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

// Visualização pública do ranking.
app.get("/api/challenge-ranking", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, rank_position, player_name
             FROM challenge_players
             ORDER BY rank_position ASC, id ASC`
        );

        res.json(result.rows);
    } catch (error) {
        sendApiError(res, error);
    }
});

// Adicionar jogador em uma posição específica.
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
                message: "Informe um nome de até 60 caracteres e uma posição válida."
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

// Editar nome do jogador.
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

// Reordenar todos os jogadores.
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

// Excluir jogador e reorganizar posições.
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
// SUPORTE — CONSULTAR CHAMADO COM CÓDIGO
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

            // As mensagens são excluídas pelo ON DELETE CASCADE.
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
// PÁGINAS DO SITE
// ==========================================

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
    await pool.query(`
        CREATE TABLE IF NOT EXISTS challenge_players (
            id SERIAL PRIMARY KEY,
            rank_position INTEGER NOT NULL,
            player_name VARCHAR(60) NOT NULL
        )
    `);

    await createSupportTables();

    app.listen(PORT, () => {
        console.log("Academia Storm iniciada na porta " + PORT);
        console.log("Scoreboards board: " + BOARD_ID);
        console.log("PostgreSQL conectado.");
        console.log("Tabelas do suporte verificadas.");
    });
}

startServer().catch(error => {
    console.error("Falha ao iniciar o servidor:", error);
    process.exit(1);
});