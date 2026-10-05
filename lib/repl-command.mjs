// $ binds more weakly than >> in Haskell. Every submitted IO action MUST be
// parenthesized before sequencing (p "deck" $ pattern >> next is NOT IO >> IO).
export function replCommand(commands, begin = '__PI_TIDAL_BEGIN__', end = '__PI_TIDAL_END__') {
  if (!commands.length) throw Error('REPL query needs at least one action');
  return `putStrLn ${JSON.stringify(begin)} >> (${commands.map(command => `(${command})`).join(' >> ')}) >> putStrLn ${JSON.stringify(end)}`;
}
