// Botão "olho": mostra/esconde o texto de um campo de palavra-passe/código
document.querySelectorAll('.pwwrap').forEach((w) => {
  const input = w.querySelector('input'), btn = w.querySelector('.eye');
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
    btn.setAttribute('aria-label', show ? 'Esconder' : 'Mostrar');
    btn.classList.toggle('on', show);
    input.focus();
  });
});
