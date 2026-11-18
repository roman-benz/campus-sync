// Testserver für das SSO-Fenster: /launch leitet wie Moodles launch.php auf moodlemobile://token=… um.
import http from 'node:http';

http
  .createServer((req, res) => {
    if (req.url.startsWith('/launch')) {
      res.writeHead(302, { Location: 'moodlemobile://token=VEVTVA==' });
      return res.end();
    }
    res.writeHead(404);
    res.end();
  })
  .listen(8799, '127.0.0.1', () => console.log('SSO-Testserver auf http://127.0.0.1:8799'));
