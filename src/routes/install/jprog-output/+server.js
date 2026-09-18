import installerTemplate from '/jprog/install-output-folder.sh?raw';

function shellSingleQuote(value) {
  return String(value).replaceAll("'", "'\"'\"'");
}

export function GET({ url }) {
  const script = installerTemplate.replaceAll(
    '__JPROG_OUTPUT_HUB_ORIGIN__',
    shellSingleQuote(url.origin)
  );
  return new Response(script, {
    headers: {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'content-disposition': 'inline; filename="install-jprog-output.sh"',
      'cache-control': 'no-store'
    }
  });
}
