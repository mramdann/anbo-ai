function readWhenReady(read) {
  if ((document.readyState !== 'interactive' && document.readyState !== 'complete') || !document.body) {
    return JSON.stringify({ ok: false, error: 'document_not_ready' });
  }
  return read();
}
