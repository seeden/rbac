module.exports = {
  presets: [
    ['@babel/preset-env', {
      targets: { node: '18' },
    }],
    '@babel/preset-flow',
  ],
  plugins: [
    '@babel/plugin-proposal-export-default-from',
  ],
};
