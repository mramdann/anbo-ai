function memoizeElement(read) {
  const values = new WeakMap();
  return element => {
    if (!values.has(element)) values.set(element, read(element));
    return values.get(element);
  };
}
