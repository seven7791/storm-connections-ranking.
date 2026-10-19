const fs = require("fs");
const path = require("path");

const pasta = __dirname;
const arquivo = path.join(pasta, "index.html");
const backup = path.join(pasta, "index.backup.html");

if (!fs.existsSync(arquivo)) {
    console.error("ERRO: index.html não encontrado.");
    process.exit(1);
}

let html = fs.readFileSync(arquivo, "utf8");
const original = html;

function substituirUnico(regex, novo, descricao) {
    const encontrados = html.match(regex);

    if (!encontrados || encontrados.length !== 1) {
        console.error("ERRO: não encontrei exatamente um trecho para: " + descricao);
        console.error("Nenhuma alteração foi salva.");
        process.exit(1);
    }

    html = html.replace(regex, novo);
}

// Evita duplicar a seção se o script já tiver sido executado.
if (
    html.includes('id="desafios"') ||
    html.includes('id="challenge-ranking-body"')
) {
    console.error("O Ranking de Desafios já parece existir no index.html.");
    console.error("Nenhuma alteração foi salva.");
    process.exit(1);
}

// 1. CSS do ranking.
const marcadorCSS = /\/\*\s*HISTÓRICO\s*\*\//;

const estilo = `/* RANKING DE DESAFIOS */
.challenge-box {
    max-width: 900px;
    margin: auto;
    overflow: hidden;
    background: rgba(3, 14, 32, .88);
    border: 1px solid rgba(0, 153, 255, .35);
    box-shadow: 0 0 40px rgba(0, 0, 0, .3);
}

.challenge-table {
    width: 100%;
    border-collapse: collapse;
}

.challenge-table th {
    padding: 18px 15px;
    background: rgba(0, 136, 255, .12);
    color: #00aaff;
    font-size: 14px;
    letter-spacing: 1px;
    border-bottom: 1px solid rgba(0, 153, 255, .3);
}

.challenge-table td {
    padding: 17px 15px;
    border-bottom: 1px solid rgba(255, 255, 255, .06);
}

.challenge-table tbody tr:hover {
    background: rgba(0, 153, 255, .08);
}

.challenge-position {
    width: 120px;
    text-align: center;
    color: #ffd84d;
    font-size: 20px;
    font-weight: 700;
}

.challenge-player {
    color: white;
    font-weight: 700;
}

@media (max-width: 600px) {
    .challenge-table th,
    .challenge-table td {
        padding: 12px 10px;
    }
}

`;

if (!marcadorCSS.test(html)) {
    console.error("ERRO: não encontrei o marcador HISTÓRICO no CSS.");
    process.exit(1);
}

html = html.replace(marcadorCSS, estilo + "$&");

// 2. Links do menu.
substituirUnico(
    /<a\s+href="#ranking"\s*>\s*RANKING\s*<\/a>/i,
    '$&\n<a href="#desafios">DESAFIOS</a>',
    "link RANKING"
);

substituirUnico(
    /<a\s+href="#elo"\s*>\s*ELO\s*<\/a>/i,
    '$&\n<a href="/admin">ADMIN</a>',
    "link ELO"
);

// 3. Seção pública.
const secao = `<!-- RANKING DE DESAFIOS -->
<section id="desafios">
    <div class="section-title">
        <h2>RANKING DE DESAFIOS</h2>
        <p>Classificação independente por posição. Desafie quem está acima de você!</p>
    </div>

    <div class="status" id="challenge-status">
        Carregando ranking de desafios...
    </div>

    <div class="challenge-box">
        <table class="challenge-table">
            <thead>
                <tr>
                    <th>POSIÇÃO</th>
                    <th>JOGADOR</th>
                </tr>
            </thead>
            <tbody id="challenge-ranking-body">
                <tr>
                    <td colspan="2" style="text-align:center">
                        Carregando jogadores...
                    </td>
                </tr>
            </tbody>
        </table>
    </div>
</section>

`;

const marcadorHistorico = /<!--\s*HISTÓRICO\s*-->/;

if (!marcadorHistorico.test(html)) {
    console.error("ERRO: não encontrei a seção HISTÓRICO.");
    process.exit(1);
}

html = html.replace(marcadorHistorico, secao + "$&");

// 4. Função que carrega os jogadores.
const funcao = `/* RANKING DE DESAFIOS */
async function atualizarRankingDesafios() {
    const status = document.getElementById("challenge-status");
    const corpo = document.getElementById("challenge-ranking-body");

    if (!status || !corpo) return;

    try {
        const resposta = await fetch("/api/challenge-ranking", {
            cache: "no-store"
        });

        if (!resposta.ok) {
            throw new Error("HTTP " + resposta.status);
        }

        const jogadores = await resposta.json();

        if (!Array.isArray(jogadores)) {
            throw new Error("Formato de dados inválido.");
        }

        corpo.replaceChildren();

        if (jogadores.length === 0) {
            const linha = document.createElement("tr");
            const celula = document.createElement("td");

            celula.colSpan = 2;
            celula.style.textAlign = "center";
            celula.textContent = "Ainda não há jogadores cadastrados.";

            linha.appendChild(celula);
            corpo.appendChild(linha);
            status.textContent = "Ranking de desafios conectado.";
            return;
        }

        jogadores.forEach((jogador, indice) => {
            const linha = document.createElement("tr");
            const posicao = document.createElement("td");
            const nome = document.createElement("td");

            posicao.className = "challenge-position";
            posicao.textContent = jogador.rank_position ?? indice + 1;

            nome.className = "challenge-player";
            nome.textContent = jogador.player_name ?? "Jogador";

            linha.append(posicao, nome);
            corpo.appendChild(linha);
        });

        status.textContent =
            jogadores.length + " jogador(es) no ranking de desafios.";
    } catch (erro) {
        console.error("Erro no ranking de desafios:", erro);
        status.textContent = "Não foi possível carregar o ranking de desafios.";

        corpo.replaceChildren();

        const linha = document.createElement("tr");
        const celula = document.createElement("td");

        celula.colSpan = 2;
        celula.style.textAlign = "center";
        celula.textContent = "Erro ao carregar. Tente novamente mais tarde.";

        linha.appendChild(celula);
        corpo.appendChild(linha);
    }
}

`;

// Procura uma área de inicialização por comentário ou pelas chamadas existentes.
const regexInicio = /\/\*[\s\S]{0,150}?INICIAR[\s\S]{0,100}?\*\//i;
const inicio = html.match(regexInicio);

if (inicio) {
    html = html.replace(regexInicio, funcao + inicio[0]);
} else {
    // Alternativa: inserir antes das chamadas de inicialização já existentes.
    const regexChamada = /^\s*atualizarRanking\(\);\s*$/m;
    const chamada = html.match(regexChamada);

    if (!chamada) {
        console.error("ERRO: não encontrei onde inserir a função de desafios.");
        console.error("Nenhuma alteração foi salva.");
        process.exit(1);
    }

    html = html.replace(regexChamada, funcao + "\n" + chamada[0]);
}

// 5. Adiciona a chamada inicial, sem duplicá-la.
if (!html.includes("atualizarRankingDesafios();")) {
    const regexInicial = /^(\s*atualizarRanking\(\);\s*)$/m;

    if (!regexInicial.test(html)) {
        console.error("ERRO: não encontrei a chamada inicial de atualizarRanking().");
        console.error("Nenhuma alteração foi salva.");
        process.exit(1);
    }

    html = html.replace(
        regexInicial,
        "$1\natualizarRankingDesafios();"
    );
}

// 6. Adiciona a atualização periódica antes do fechamento do script.
// Usa setInterval apenas se ainda não existir um para esta função.
if (!/setInterval\s*\(\s*atualizarRankingDesafios\s*,/.test(html)) {
    const regexIntervalo = /setInterval\s*\(\s*atualizarHistorico\s*,\s*30000\s*\)\s*;?/;

    if (regexIntervalo.test(html)) {
        html = html.replace(
            regexIntervalo,
            '$&\n\nsetInterval(atualizarRankingDesafios, 30000);'
        );
    } else {
        const fechamento = html.lastIndexOf("</script>");

        if (fechamento === -1) {
            console.error("ERRO: não encontrei o fechamento do script.");
            console.error("Nenhuma alteração foi salva.");
            process.exit(1);
        }

        html =
            html.slice(0, fechamento) +
            "\nsetInterval(atualizarRankingDesafios, 30000);\n" +
            html.slice(fechamento);
    }
}

// Não sobrescreve um backup existente.
if (fs.existsSync(backup)) {
    console.error("ERRO: index.backup.html já existe.");
    console.error("Renomeie esse backup antes de executar o script.");
    console.error("Nenhuma alteração foi salva.");
    process.exit(1);
}

fs.writeFileSync(backup, original, "utf8");
fs.writeFileSync(arquivo, html, "utf8");

console.log("SUCESSO: Ranking de Desafios adicionado ao index.html.");
console.log("Backup original salvo em index.backup.html.");
console.log("Confira o site antes de publicar.");