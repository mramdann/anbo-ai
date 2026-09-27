const token = location.hash.slice(1);
if (/^[a-f0-9]{64}$/.test(token)) document.title = `Anbo Dock ${token}`;
