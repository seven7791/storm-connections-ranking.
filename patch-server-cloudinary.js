/* Cloudinary patch for the current Academia Storm server.js.
   Run from the project folder: node patch-server-cloudinary.js */

const fs = require('fs');
const path = require('path');

const file = path.join(process.cwd(), 'server.js');

if (!fs.existsSync(file)) {
    throw new Error('server.js não encontrado na pasta atual.');
}

let s = fs.readFileSync(file, 'utf8');

if (s.includes('CLOUDINARY_STORM_INTEGRATION')) {
    console.log('A integração Cloudinary já parece estar instalada.');
    process.exit(0);
}

function replaceOnce(oldText, newText, label) {
    const at = s.indexOf(oldText);

    if (at < 0) {
        throw new Error(
            'Ponto não encontrado: ' + label +
            '. Nenhuma alteração foi salva.'
        );
    }

    s = s.slice(0, at) + newText + s.slice(at + oldText.length);
}

const backup = path.join(
    process.cwd(),
    'server.js.backup-cloudinary'
);

fs.copyFileSync(file, backup);

replaceOnce(
    'const crypto = require("crypto");',
    'const crypto = require("crypto");\n' +
    'const cloudinary = require("cloudinary").v2;\n' +
    'const multer = require("multer");',
    'imports'
);

replaceOnce(
    'const SCOREBOARDS_API_KEY = process.env.SCOREBOARDS_API_KEY;',
    String.raw`const SCOREBOARDS_API_KEY = process.env.SCOREBOARDS_API_KEY;

// CLOUDINARY_STORM_INTEGRATION
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
});`,
    'Cloudinary config'
);

const routeAnchor =
    '// ==========================================\n' +
    '// RANKING DE DESAFIOS — POSTGRESQL\n' +
    '// ==========================================';

const routes = String.raw`// ==========================================
// FOTOS DE JOGADORES — CLOUDINARY
// ==========================================

app.get("/api/player-photos", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT player_type, player_id, player_name, photo_url " +
            "FROM player_photos ORDER BY player_name"
        );

        res.set("Cache-Control", "no-store");
        res.json(result.rows);
    } catch (error) {
        sendApiError(res, error);
    }
});

app.post(
    "/api/admin/player-photo",
    requireAdmin,
    (req, res, next) => {
        imageUpload.single("photo")(req, res, error => {
            if (error) {
                return res.status(400).json({
                    error: true,
                    message: error.message ||
                        "Arquivo de imagem inválido."
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
                message: "Identificador ou nome do jogador inválido."
            });
        }

        if (
            !process.env.CLOUDINARY_CLOUD_NAME ||
            !process.env.CLOUDINARY_API_KEY ||
            !process.env.CLOUDINARY_API_SECRET
        ) {
            return res.status(503).json({
                error: true,
                message: "Configure as três variáveis CLOUDINARY no Render."
            });
        }

        try {
            const uploaded = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    {
                        folder: "academia-storm/players",
                        resource_type: "image",
                        transformation: [
                            {
                                width: 600,
                                height: 600,
                                crop: "limit",
                                quality: "auto",
                                fetch_format: "auto"
                            }
                        ]
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

            const saved = await pool.query(
                "INSERT INTO player_photos " +
                "(player_type, player_id, player_name, photo_url, public_id) " +
                "VALUES ($1, $2, $3, $4, $5) " +
                "ON CONFLICT (player_type, player_id) DO UPDATE SET " +
                "player_name = EXCLUDED.player_name, " +
                "photo_url = EXCLUDED.photo_url, " +
                "public_id = EXCLUDED.public_id, " +
                "updated_at = NOW() " +
                "RETURNING player_type, player_id, player_name, photo_url",
                [
                    playerType,
                    playerId,
                    playerName,
                    uploaded.secure_url,
                    uploaded.public_id
                ]
            );

            res.status(201).json({
                success: true,
                photo: saved.rows[0]
            });
        } catch (error) {
            sendApiError(res, error);
        }
    }
);

`;

replaceOnce(
    routeAnchor,
    routes + routeAnchor,
    'photo routes'
);

const oldChallengeQuery = `const result = await pool.query(
            \`SELECT id, rank_position, player_name
             FROM challenge_players
             ORDER BY rank_position ASC, id ASC\`
        );`;

const newChallengeQuery = `const result = await pool.query(
            \`SELECT cp.id, cp.rank_position, cp.player_name, pp.photo_url
             FROM challenge_players cp
             LEFT JOIN player_photos pp
               ON pp.player_type = 'challenge'
              AND pp.player_id = cp.id::text
             ORDER BY cp.rank_position ASC, cp.id ASC\`
        );`;

replaceOnce(
    oldChallengeQuery,
    newChallengeQuery,
    'challenge ranking query'
);

const oldTable = `    await pool.query(\`
        CREATE TABLE IF NOT EXISTS challenge_players (
            id SERIAL PRIMARY KEY,
            rank_position INTEGER NOT NULL,
            player_name VARCHAR(60) NOT NULL
        )
    \`);
`;

const newTable = `    await pool.query(\`
        CREATE TABLE IF NOT EXISTS challenge_players (
            id SERIAL PRIMARY KEY,
            rank_position INTEGER NOT NULL,
            player_name VARCHAR(60) NOT NULL
        )
    \`);

    await pool.query(\`
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
    \`);
`;

replaceOnce(
    oldTable,
    newTable,
    'photo table'
);

fs.writeFileSync(file, s, 'utf8');

console.log(
    'Integração Cloudinary aplicada. ' +
    'Backup criado em server.js.backup-cloudinary.'
);

console.log(
    'Instale as dependências com: npm install cloudinary multer'
);