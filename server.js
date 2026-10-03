require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;
const BOARD_ID = "754526789448";
const SCOREBOARDS_API_KEY = process.env.SCOREBOARDS_API_KEY;

app.use(express.json());
app.use(express.static(__dirname));

async function scoreboardsFetch(endpoint) {
    if (!SCOREBOARDS_API_KEY) {
        throw new Error("SCOREBOARDS_API_KEY não configurada.");
    }

    const response = await fetch(
        "https://api.scoreboards.dev/v1" + endpoint,
        {
            method: "GET",
            headers: {
                "Authorization": "Bearer " + SCOREBOARDS_API_KEY,
                "Accept": "application/json"
            }
        }
    );

    const text = await response.text();

    if (!response.ok) {
        console.log("ERRO SCOREBOARDS");
        console.log("Status:", response.status);
        console.log("Resposta:", text);

        const error = new Error(
            "Scoreboards respondeu HTTP " + response.status
        );

        error.status = response.status;

        throw error;
    }

    try {
        return text ? JSON.parse(text) : {};
    } catch (error) {
        throw new Error("Resposta inválida do Scoreboards.");
    }
}


// RANKING
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

        res.json(data);

    } catch (error) {
        console.log("ERRO NO RANKING:", error.message);

        res.status(error.status || 500).json({
            error: true,
            message: error.message
        });
    }
});


// HISTÓRICO GERAL
app.get("/api/matches", async (req, res) => {
    try {
        const limit = Math.min(
            Math.max(Number(req.query.limit) || 25, 1),
            200
        );

        let endpoint =
            "/boards/" +
            encodeURIComponent(BOARD_ID) +
            "/matches?limit=" +
            limit +
            "&status=approved";

        if (req.query.cursor) {
            endpoint +=
                "&cursor=" +
                encodeURIComponent(req.query.cursor);
        }

        const data = await scoreboardsFetch(endpoint);

        res.json(data);

    } catch (error) {
        console.log("ERRO NO HISTÓRICO:", error.message);

        res.status(error.status || 500).json({
            error: true,
            message: error.message
        });
    }
});


// HISTÓRICO DO JOGADOR
app.get("/api/player/:playerId/matches", async (req, res) => {
    try {
        const playerId = req.params.playerId;

        const limit = Math.min(
            Math.max(Number(req.query.limit) || 200, 1),
            200
        );

        let endpoint =
            "/boards/" +
            encodeURIComponent(BOARD_ID) +
            "/matches?player=" +
            encodeURIComponent(playerId) +
            "&limit=" +
            limit +
            "&status=approved";

        if (req.query.cursor) {
            endpoint +=
                "&cursor=" +
                encodeURIComponent(req.query.cursor);
        }

        const data = await scoreboardsFetch(endpoint);

        res.json(data);

    } catch (error) {
        console.log(
            "ERRO NO HISTÓRICO DO JOGADOR:",
            error.message
        );

        res.status(error.status || 500).json({
            error: true,
            message: error.message
        });
    }
});


// PERFIL DO JOGADOR
app.get("/api/player/:playerId", async (req, res) => {
    try {
        const playerId = req.params.playerId;

        const data = await scoreboardsFetch(
            "/boards/" +
            encodeURIComponent(BOARD_ID) +
            "/entries/" +
            encodeURIComponent(playerId)
        );

        res.json(data);

    } catch (error) {
        console.log("ERRO NO PERFIL:", error.message);

        res.status(error.status || 500).json({
            error: true,
            message: error.message
        });
    }
});


// PÁGINA PRINCIPAL
app.get("/{*splat}", (req, res) => {
    res.sendFile(
        path.join(__dirname, "index.html")
    );
});


// INICIAR SERVIDOR
app.listen(PORT, () => {
    console.log("");
    console.log("=================================");
    console.log(" STORM CONNECTIONS RANKING");
    console.log("=================================");
    console.log("Servidor iniciado na porta: " + PORT);
    console.log("Board ID: " + BOARD_ID);
    console.log("=================================");
    console.log("");
});