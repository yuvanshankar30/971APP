import installerTemplate from '/jprog/install-output-folder.ps1?raw';

function powerShellSingleQuote(value) {
  return String(value).replaceAll("'", "''");
}

export function GET({ url }) {
  const script = installerTemplate.replaceAll(
    '__JPROG_OUTPUT_HUB_ORIGIN__',
    powerShellSingleQuote(url.origin)
  );
  return new Response(script, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': 'inline; filename="install-jprog-output.ps1"',
      'cache-control': 'no-store'
    }
  });
}
