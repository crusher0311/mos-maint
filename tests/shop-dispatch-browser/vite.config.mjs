import { defineConfig } from "../../artifacts/detect-dog-workflow/node_modules/vite/dist/node/index.js";
import path from "node:path";
const root=process.cwd();
const deps=path.join(root,"artifacts/detect-dog-workflow/node_modules");
export default defineConfig({
 root:path.join(root,"tests/shop-dispatch-browser"),
 resolve:{alias:[
  {find:"@",replacement:root},
  {find:/^react(\/.*)?$/,replacement:deps+"/react$1"},
  {find:/^react-dom(\/.*)?$/,replacement:deps+"/react-dom$1"},
  {find:"zod",replacement:deps+"/zod/index.js"},
 ]},
 esbuild:{jsx:"automatic"},
 css:{postcss:{plugins:[]}},
 server:{host:"0.0.0.0",port:24100,strictPort:true,allowedHosts:true,fs:{allow:[root]}},
});
