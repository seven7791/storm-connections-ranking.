require("dotenv").config();

const express = require("express");
const path = require("path");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

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

function sendApiError(res, error) {
    console.error(error);
    res.status(error.status || 500).json({
        error: true,
        message: error.status
            ? error.message
            : "Ocorreu um erro interno no servidor."
    });
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
// LOGIN ADMINISTRATIVO
// ==========================================

function requireAdmin(req, res, next) {
    if (req.session && req.session.isAdmin === true) {
        return next();
    }

    return res.status(401).json({
        error: true,
        message: "Faça login como administrador."
    });
}

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

// Público: todos podem visualizar.
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
        const playerName = String(req.body?.player_name || "").trim();
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
                    message: "A posição deve estar entre 1 e " + (list.rowCount + 1) + "."
                });
            }

            const created = await client.query(
                `INSERT INTO challenge_players (player_name, rank_position)
                 VALUES ($1, $2)
                 RETURNING id`,
                [playerName, list.rowCount + 1]
            );

            const ids = list.rows.map(row => Number(row.id));
            ids.splice(requestedPosition - 1, 0, Number(created.rows[0].id));

            for (let i = 0; i < ids.length; i++) {
                await client.query(
                    "UPDATE challenge_players SET rank_position = $1 WHERE id = $2",
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
// EDITAR NOME DO JOGADOR — NOVA ROTA
// ==========================================

app.patch(
    "/api/admin/challenge-ranking/:id",
    requireAdmin,
    async (req, res) => {
        const id = Number(req.params.id);
        const playerName = String(req.body?.player_name || "").trim();

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

            if (result.rowCount === 0) {
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

// Reordenar jogadores: envie a lista completa de IDs na ordem desejada.
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
                    "UPDATE challenge_players SET rank_position = $1 WHERE id = $2",
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
                    "UPDATE challenge_players SET rank_position = $1 WHERE id = $2",
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
// PÁGINAS DO SITE
// ==========================================

app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "admin.html"));
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

    app.listen(PORT, () => {
        console.log("Academia Storm iniciada na porta " + PORT);
        console.log("Scoreboards board: " + BOARD_ID);
        console.log("PostgreSQL conectado.");
    });
}

startServer().catch(error => {
    console.error("Falha ao iniciar o servidor:", error);
    process.exit(1);
});