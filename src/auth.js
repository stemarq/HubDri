// Login da equipe pelo Supabase Auth.
//
// O navegador nunca fala com o Supabase: o servidor faz o login e guarda a sessão em
// cookies httpOnly. Assim imagens e PDF (abertos por link) também ficam protegidos.
// Toda conta do Auth entra; a dona pode bloquear alguém (perfis.ativo = false).
import { createClient } from "@supabase/supabase-js";
import { env } from "./config.js";
import * as store from "./store.js";
import { paginaEntrar, paginaEsqueciSenha, paginaDefinirSenha, paginaBloqueado } from "./paginas-acesso.js";

export const loginAtivo = store.modo === "supabase";

// Um cliente novo por chamada de Auth: a sessão de uma pessoa nunca fica guardada no
// cliente que o store usa com a service_role.
const clienteAuth = () =>
  createClient(env.supabaseUrl, env.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

// ---------- Cookies ----------

const COOKIE_ACESSO = "hub_sessao";
const COOKIE_RENOVA = "hub_renova";
const TRINTA_DIAS = 30 * 24 * 60 * 60 * 1000;
const opcoesCookie = { httpOnly: true, sameSite: "lax", secure: env.publicUrl.startsWith("https://"), path: "/", maxAge: TRINTA_DIAS };

function lerCookies(req) {
  const cookies = {};
  for (const parte of (req.get("cookie") || "").split(";")) {
    const i = parte.indexOf("=");
    if (i > 0) cookies[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return cookies;
}

function gravarSessao(res, sessao) {
  res.cookie(COOKIE_ACESSO, sessao.access_token, opcoesCookie);
  res.cookie(COOKIE_RENOVA, sessao.refresh_token, opcoesCookie);
}

function limparSessao(res) {
  const { maxAge, ...opcoes } = opcoesCookie;
  res.clearCookie(COOKIE_ACESSO, opcoes);
  res.clearCookie(COOKIE_RENOVA, opcoes);
}

// ---------- Sessão ----------

const expiraEm = (jwt) => {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).exp * 1000;
  } catch {
    return 0;
  }
};

// Token já conferido no Supabase → id do usuário, até o token expirar (evita uma chamada por requisição).
const conferidos = new Map();

async function usuarioDoToken(token) {
  if (!token || expiraEm(token) <= Date.now() + 5_000) return null;
  const salvo = conferidos.get(token);
  if (salvo) return salvo;
  const { data, error } = await clienteAuth().auth.getUser(token);
  if (error || !data?.user) return null;
  if (conferidos.size > 1000) conferidos.clear();
  conferidos.set(token, data.user.id);
  return data.user.id;
}

// Renovações em andamento: várias requisições ao mesmo tempo usam a mesma renovação.
const renovacoes = new Map();

function renovar(refreshToken) {
  if (!renovacoes.has(refreshToken)) {
    const p = clienteAuth().auth.refreshSession({ refresh_token: refreshToken })
      .then(({ data, error }) => (error ? null : data.session))
      .catch(() => null);
    renovacoes.set(refreshToken, p);
    p.finally(() => setTimeout(() => renovacoes.delete(refreshToken), 10_000).unref());
  }
  return renovacoes.get(refreshToken);
}

// Perfis ativos ficam 30 s em cache; bloqueados são conferidos a cada vez (para desbloquear na hora).
const perfis = new Map();

async function perfilDe(uid) {
  const salvo = perfis.get(uid);
  if (salvo && salvo.ate > Date.now()) return salvo.perfil;
  const perfil = await store.buscarPerfil(uid);
  if (perfil?.ativo) perfis.set(uid, { perfil, ate: Date.now() + 30_000 });
  else perfis.delete(uid);
  return perfil;
}

// Lê (e renova, se preciso) a sessão dos cookies. Devolve o perfil ou null.
async function sessaoAtual(req, res) {
  const cookies = lerCookies(req);
  let uid = await usuarioDoToken(cookies[COOKIE_ACESSO]);
  if (!uid && cookies[COOKIE_RENOVA]) {
    const sessao = await renovar(cookies[COOKIE_RENOVA]);
    if (sessao) {
      gravarSessao(res, sessao);
      uid = sessao.user?.id ?? (await usuarioDoToken(sessao.access_token));
    }
  }
  if (!uid) return null;
  // Conta sem perfil (ex.: criada antes da migration) fica sem acesso até ter um perfil.
  return (await perfilDe(uid)) ?? { id: uid, email: "", ativo: false };
}

const querJson = (req) => req.path.startsWith("/api/") || req.path.startsWith("/uploads/");

// Middleware: tudo depois dele exige login (e conta não bloqueada).
export async function exigirLogin(req, res, next) {
  try {
    const perfil = await sessaoAtual(req, res);
    if (!perfil) {
      limparSessao(res);
      if (querJson(req)) return res.status(401).json({ erro: "Sua sessão expirou. Entre novamente." });
      return res.redirect("/login");
    }
    if (!perfil.ativo) {
      if (querJson(req)) return res.status(403).json({ erro: "Seu acesso ao hub está bloqueado." });
      return res.status(403).send(paginaBloqueado(perfil));
    }
    req.usuario = { id: perfil.id, nome: perfil.nome || perfil.email, email: perfil.email, papel: perfil.papel };
    next();
  } catch (e) {
    next(e);
  }
}

// ---------- Rotas das telas de acesso ----------

const MENSAGENS = {
  invalid_credentials: "E-mail ou senha incorretos.",
  email_not_confirmed: "Confirme seu e-mail pelo link que enviamos antes de entrar.",
  over_request_rate_limit: "Muitas tentativas. Espere alguns minutos e tente de novo.",
  over_email_send_rate_limit: "Muitos e-mails enviados. Espere alguns minutos e tente de novo.",
  user_banned: "Esta conta está bloqueada.",
};
const mensagem = (erro, padrao) => MENSAGENS[erro?.code] || padrao;

export function rotasDeAcesso(app) {
  app.get("/login", async (req, res, next) => {
    try {
      if (await sessaoAtual(req, res)) return res.redirect("/");
      res.send(paginaEntrar());
    } catch (e) {
      next(e);
    }
  });

  app.post("/login", async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const senha = String(req.body.senha || "");
    if (!email || !senha) return res.status(400).send(paginaEntrar({ erro: "Preencha e-mail e senha.", email }));
    const { data, error } = await clienteAuth().auth.signInWithPassword({ email, password: senha });
    if (error || !data?.session) {
      if (error && !MENSAGENS[error.code]) console.warn("Login falhou:", error.code || error.message);
      return res.status(401).send(paginaEntrar({ erro: mensagem(error, "E-mail ou senha incorretos."), email }));
    }
    gravarSessao(res, data.session);
    res.redirect(303, "/");
  });

  app.post("/sair", async (req, res) => {
    const token = lerCookies(req)[COOKIE_ACESSO];
    if (token) {
      conferidos.delete(token);
      // Encerra a sessão no Supabase também (o refresh token deixa de valer).
      await clienteAuth().auth.admin.signOut(token).catch(() => {});
    }
    limparSessao(res);
    res.redirect(303, "/login");
  });

  app.get("/esqueci-senha", (req, res) => res.send(paginaEsqueciSenha()));

  app.post("/esqueci-senha", async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email) return res.status(400).send(paginaEsqueciSenha({ erro: "Informe seu e-mail." }));
    const { error } = await clienteAuth().auth.resetPasswordForEmail(email, { redirectTo: `${env.publicUrl}/definir-senha` });
    // Mesma resposta exista ou não a conta, para não revelar quem tem cadastro.
    if (error?.code?.startsWith("over_")) return res.status(429).send(paginaEsqueciSenha({ erro: mensagem(error) }));
    if (error) console.warn("Recuperação de senha falhou:", error.code || error.message);
    res.send(paginaEsqueciSenha({ enviado: true }));
  });

  // Destino dos links de convite e de recuperação (os tokens vêm no "#", lidos pelo script da página).
  app.get("/definir-senha", (req, res) => res.send(paginaDefinirSenha()));

  app.post("/definir-senha", async (req, res) => {
    const { access_token: at, refresh_token: rt, senha = "", confirmacao = "" } = req.body;
    if (senha.length < 8) return res.status(400).send(paginaDefinirSenha({ erro: "A senha precisa ter pelo menos 8 caracteres." }));
    if (senha !== confirmacao) return res.status(400).send(paginaDefinirSenha({ erro: "As duas senhas não são iguais." }));
    const uid = await usuarioDoToken(at);
    if (!uid) return res.status(401).send(paginaDefinirSenha({ erro: "Este link expirou. Peça um novo em “Esqueci minha senha”." }));
    const { error } = await clienteAuth().auth.admin.updateUserById(uid, { password: senha });
    if (error) {
      const fraca = error.code === "weak_password" || error.code === "same_password";
      return res.status(400).send(paginaDefinirSenha({
        erro: error.code === "same_password" ? "Escolha uma senha diferente da anterior."
          : fraca ? "Senha fraca. Use letras, números e pelo menos 8 caracteres." : "Não foi possível salvar a senha. Tente de novo.",
      }));
    }
    if (rt) gravarSessao(res, { access_token: at, refresh_token: rt });
    res.redirect(303, rt ? "/" : "/login");
  });
}
