// Telas de acesso do hub: entrar, esqueci a senha, definir senha e acesso bloqueado.
import { config } from "./config.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function layout(titulo, corpo, script = "") {
  const empresa = config().empresa.nome;
  return `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f7f3ef"><meta name="robots" content="noindex">
<title>${esc(titulo)} · ${esc(empresa)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Inter+Tight:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/cliente.css">
</head><body class="acesso">
<main>
  <header><strong>${esc(empresa)}</strong><span class="label">Acesso da equipe</span></header>
  ${corpo}
</main>
${script ? `<script>${script}</script>` : ""}
</body></html>`;
}

const aviso = (erro, ok) =>
  (erro ? `<p class="erro" role="alert">${esc(erro)}</p>` : "") + (ok ? `<p class="sucesso" role="status">${esc(ok)}</p>` : "");

// Links de convite e de recuperação do Supabase chegam com os tokens no "#".
// Se caírem aqui (Site URL), seguem para a tela de definir senha.
const SCRIPT_REDIRECIONA_LINK = `
  if (/[#&](access_token|error_description)=/.test(location.hash)) location.replace("/definir-senha" + location.hash);
`;

export function paginaEntrar({ erro, ok, email } = {}) {
  return layout("Entrar", `
  <h1>Entrar</h1>
  <section>
    ${aviso(erro, ok)}
    <form method="post" action="/login" class="formulario">
      <label class="campo"><span class="label">E-mail</span>
        <input type="email" name="email" value="${esc(email)}" autocomplete="username" inputmode="email" required ${email ? "" : "autofocus"}></label>
      <label class="campo"><span class="label">Senha</span>
        <input type="password" name="senha" autocomplete="current-password" required ${email ? "autofocus" : ""}></label>
      <button class="btn cheio">Entrar</button>
    </form>
    <p class="dica"><a href="/esqueci-senha">Esqueci minha senha</a></p>
  </section>`, SCRIPT_REDIRECIONA_LINK);
}

export function paginaEsqueciSenha({ erro, enviado } = {}) {
  return layout("Recuperar senha", `
  <h1>Recuperar senha</h1>
  <section>
    ${enviado
      ? `<p class="label">Pronto</p>
         <h2>Confira seu e-mail.</h2>
         <p>Se o endereço estiver cadastrado, você vai receber um link para criar uma nova senha.</p>`
      : `${aviso(erro)}
         <p class="intro">Informe o e-mail da sua conta. Enviaremos um link para criar uma nova senha.</p>
         <form method="post" action="/esqueci-senha" class="formulario">
           <label class="campo"><span class="label">E-mail</span>
             <input type="email" name="email" autocomplete="username" inputmode="email" required autofocus></label>
           <button class="btn cheio">Enviar link</button>
         </form>`}
    <p class="dica"><a href="/login">Voltar para entrar</a></p>
  </section>`);
}

export function paginaDefinirSenha({ erro } = {}) {
  return layout("Definir senha", `
  <h1 id="titulo">Nova senha</h1>
  <section>
    ${aviso(erro)}
    <p class="erro" id="link-invalido" role="alert" hidden>Este link é inválido ou já expirou. Peça um novo em “Esqueci minha senha”.</p>
    <form method="post" action="/definir-senha" class="formulario" id="form-senha">
      <input type="hidden" name="access_token" id="at">
      <input type="hidden" name="refresh_token" id="rt">
      <label class="campo"><span class="label">Nova senha</span>
        <input type="password" name="senha" autocomplete="new-password" minlength="8" required></label>
      <label class="campo"><span class="label">Repita a senha</span>
        <input type="password" name="confirmacao" autocomplete="new-password" minlength="8" required></label>
      <p class="dica esquerda">Use pelo menos 8 caracteres.</p>
      <button class="btn cheio">Salvar senha e entrar</button>
    </form>
    <p class="dica"><a href="/login">Voltar para entrar</a></p>
  </section>`, `
  (function () {
    var p = new URLSearchParams(location.hash.slice(1));
    var at = p.get("access_token"), rt = p.get("refresh_token");
    if (at) {
      sessionStorage.setItem("hub_link", JSON.stringify({ at: at, rt: rt || "", tipo: p.get("type") }));
      history.replaceState(null, "", location.pathname); // tira os tokens da barra de endereço
    }
    var salvo = null;
    try { salvo = JSON.parse(sessionStorage.getItem("hub_link") || "null"); } catch (e) {}
    if (salvo && salvo.tipo === "invite") document.getElementById("titulo").textContent = "Crie sua senha";
    if (!salvo || p.get("error_description")) {
      document.getElementById("link-invalido").hidden = false;
      document.getElementById("form-senha").hidden = true;
      return;
    }
    document.getElementById("at").value = salvo.at;
    document.getElementById("rt").value = salvo.rt;
  })();`);
}

export function paginaBloqueado(perfil) {
  return layout("Acesso bloqueado", `
  <h1>Sem acesso</h1>
  <section>
    <p class="label">Conta bloqueada</p>
    <h2>Seu acesso ao hub está bloqueado.</h2>
    <p>${perfil?.email ? `Você entrou como <strong>${esc(perfil.email)}</strong>. ` : ""}Fale com a responsável pelo hub para liberar de novo.</p>
    <form method="post" action="/sair" class="acoes"><button class="btn">Sair</button></form>
  </section>`);
}
