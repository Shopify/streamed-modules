// Loaded via import() after the app has rendered. Deliberately a separate
// module: it exercises a dynamic import of a module that, in the declarations
// bundle, is declared after its importer.
export function postResults(results) {
  return fetch('/__report', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(results),
    keepalive: true,
  }).catch(() => {});
}
