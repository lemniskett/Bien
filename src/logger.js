function ts() {
  return new Date().toISOString();
}

function fmt(level, args) {
  return [`${ts()} [${level}]`, ...args];
}

export const logger = {
  info: (...args) => console.log(...fmt('INFO', args)),
  warn: (...args) => console.warn(...fmt('WARN', args)),
  error: (...args) => console.error(...fmt('ERROR', args)),
  debug: (...args) => {
    if (process.env.BIEN_DEBUG) console.log(...fmt('DEBUG', args));
  },
};

export default logger;
