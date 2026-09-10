import installerTemplate from '$autocam/fusion/install-runner.sh?raw';

function shellSingleQuote(value) {
  return String(value).replaceAll("'", "'\"'\"'");
}

export function GET({ url }) {
  const script = installerTemplate.replaceAll(
    '__FUSION_HUB_ORIGIN__',
    shellSingleQuote(url.origin)
  );
  return new Response(script, {
    headers: {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'content-disposition': 'inline; filename="install-fusion-runner.sh"',
      'cache-control': 'no-store'
    }
  });
}
