const crypto = require("crypto");

function registerSupport(app, pool, requireAdmin) {
    // Todas as consultas usam parâmetros SQL para evitar injeção.

    async function ensureSupportTables() {
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

    function validateMessage(value) {
        return typeof value === "string"
            ? value.trim()
            : "";
    }

    function sendError(res, error) {
        console.error("Erro no suporte:", error);
        res.status(500).json({
            error: true,
            message: "Não foi possível concluir a operação."
        });
    }

    // ABRIR CHAMADO — público
    app.post("/api/support/tickets", async (req, res) => {
        const playerName = validateMessage(req.body?.player_name);
        const subject = validateMessage(req.body?.subject);
        const message = validateMessage(req.body?.message);

        if (
            playerName.length < 2 || playerName.length > 60 ||
            subject.length < 3 || subject.length > 100 ||
            message.length < 5 || message.length > 4000
        ) {
            return res.status(400).json({
                error: true,
                message: "Confira o nome, o assunto e a mensagem."
            });
        }

        try {
            const accessCode = crypto.randomBytes(24).toString("hex");

            const result = await pool.query(
                `INSERT INTO support_tickets
                    (access_code, player_name, subject)
                 VALUES ($1, $2, $3)
                 RETURNING id, access_code, player_name, subject,
                           status, created_at`,
                [accessCode, playerName, subject]
            );

            const ticket = result.rows[0];

            await pool.query(
                `INSERT INTO support_messages
                    (ticket_id, sender, message)
                 VALUES ($1, 'jogador', $2)`,
                [ticket.id, message]
            );

            res.status(201).json({
                success: true,
                ticket: {
                    code: ticket.access_code,
                    player_name: ticket.player_name,
                    subject: ticket.subject,
                    status: ticket.status,
                    created_at: ticket.created_at
                },
                message: "Chamado criado. Guarde seu código de acesso."
            });
        } catch (error) {
            sendError(res, error);
        }
    });

    // CONSULTAR CHAMADO COM SEU CÓDIGO DE ACESSO — público
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
            sendError(res, error);
        }
    });

    // ENVIAR MENSAGEM PELO JOGADOR — público com código secreto
    app.post("/api/support/tickets/:code/messages", async (req, res) => {
        const code = String(req.params.code || "");
        const message = validateMessage(req.body?.message);

        if (!/^[a-f0-9]{48}$/.test(code)) {
            return res.status(400).json({
                error: true,
                message: "Código de chamado inválido."
            });
        }

        if (message.length < 1 || message.length > 4000) {
            return res.status(400).json({
                error: true,
                message: "A mensagem deve ter até 4000 caracteres."
            });
        }

        try {
            const result = await pool.query(
                `SELECT id, status
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

            if (ticket.status === "resolvido") {
                return res.status(409).json({
                    error: true,
                    message: "Este chamado está resolvido."
                });
            }

            await pool.query(
                `INSERT INTO support_messages
                    (ticket_id, sender, message)
                 VALUES ($1, 'jogador', $2)`,
                [ticket.id, message]
            );

            await pool.query(
                `UPDATE support_tickets
                 SET updated_at = NOW()
                 WHERE id = $1`,
                [ticket.id]
            );

            res.status(201).json({ success: true });
        } catch (error) {
            sendError(res, error);
        }
    });

    // LISTAR TODOS OS CHAMADOS — somente administrador
    app.get("/api/admin/support/tickets", requireAdmin, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT t.id, t.access_code, t.player_name, t.subject,
                       t.status, t.created_at, t.updated_at,
                       (SELECT COUNT(*)
                        FROM support_messages m
                        WHERE m.ticket_id = t.id) AS message_count
                FROM support_tickets t
                ORDER BY
                    CASE WHEN t.status = 'resolvido' THEN 1 ELSE 0 END,
                    t.updated_at DESC,
                    t.id DESC
            `);

            res.set("Cache-Control", "no-store");
            res.json(result.rows);
        } catch (error) {
            sendError(res, error);
        }
    });

    // CONSULTAR CONVERSA NO PAINEL — somente administrador
    app.get(
        "/api/admin/support/tickets/:id",
        requireAdmin,
        async (req, res) => {
            const id = req.params.id;

            if (!/^\d+$/.test(id)) {
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

                res.json({
                    ticket: result.rows[0],
                    messages: messages.rows
                });
            } catch (error) {
                sendError(res, error);
            }
        }
    );

    // RESPONDER AO CHAMADO — somente administrador
    app.post(
        "/api/admin/support/tickets/:id/messages",
        requireAdmin,
        async (req, res) => {
            const id = req.params.id;
            const message = validateMessage(req.body?.message);

            if (!/^\d+$/.test(id)) {
                return res.status(400).json({
                    error: true,
                    message: "ID inválido."
                });
            }

            if (!message || message.length > 4000) {
                return res.status(400).json({
                    error: true,
                    message: "A resposta deve ter até 4000 caracteres."
                });
            }

            const client = await pool.connect();

            try {
                await client.query("BEGIN");

                const ticket = await client.query(
                    `SELECT id, status
                     FROM support_tickets
                     WHERE id = $1
                     FOR UPDATE`,
                    [id]
                );

                if (!ticket.rowCount) {
                    await client.query("ROLLBACK");
                    return res.status(404).json({
                        error: true,
                        message: "Chamado não encontrado."
                    });
                }

                if (ticket.rows[0].status === "resolvido") {
                    await client.query("ROLLBACK");
                    return res.status(409).json({
                        error: true,
                        message: "Reabra o chamado antes de responder."
                    });
                }

                await client.query(
                    `INSERT INTO support_messages
                        (ticket_id, sender, message)
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
                sendError(res, error);
            } finally {
                client.release();
            }
        }
    );

    // ALTERAR STATUS — somente administrador
    app.patch(
        "/api/admin/support/tickets/:id",
        requireAdmin,
        async (req, res) => {
            const id = req.params.id;
            const status = req.body?.status;

            if (!/^\d+$/.test(id)) {
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
                     RETURNING id, status`,
                    [status, id]
                );

                if (!result.rowCount) {
                    return res.status(404).json({
                        error: true,
                        message: "Chamado não encontrado."
                    });
                }

                res.json({ success: true, ticket: result.rows[0] });
            } catch (error) {
                sendError(res, error);
            }
        }
    );

    // EXCLUIR CHAMADO E TODAS AS MENSAGENS — somente administrador
    app.delete(
        "/api/admin/support/tickets/:id",
        requireAdmin,
        async (req, res) => {
            const id = req.params.id;

            if (!/^\d+$/.test(id)) {
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

                // As mensagens são apagadas automaticamente por ON DELETE CASCADE.
                res.json({ success: true });
            } catch (error) {
                sendError(res, error);
            }
        }
    );

    // As páginas são servidas pelo Express.
    app.get("/suporte", (req, res) => {
        res.sendFile(require("path").join(__dirname, "suporte.html"));
    });

    app.get("/admin-suporte", (req, res) => {
        res.sendFile(require("path").join(__dirname, "admin-suporte.html"));
    });

    return { ensureSupportTables };
}

module.exports = registerSupport;