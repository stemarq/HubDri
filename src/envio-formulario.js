// Script das páginas renderizadas no servidor (acesso e página da cliente):
// ao enviar um formulário, o botão mostra o progresso (data-carregando) e evita clique duplo.
export const SCRIPT_ENVIO = `
  document.addEventListener("submit", function (e) {
    var form = e.target, botao = e.submitter || form.querySelector("button");
    if (form.dataset.enviando) { e.preventDefault(); return; }
    form.dataset.enviando = "1";
    if (!botao) return;
    // Desativar no próximo tique: o valor do botão (name/value) ainda entra no envio.
    setTimeout(function () {
      form.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
      botao.setAttribute("aria-busy", "true");
      botao.innerHTML = '<span class="spinner" aria-hidden="true"></span>' + (botao.dataset.carregando || "Enviando…");
    }, 0);
  });
  // Voltar pelo histórico (cache da página) não pode deixar o botão travado.
  window.addEventListener("pageshow", function (e) { if (e.persisted) location.reload(); });
`;
