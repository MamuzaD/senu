// `import x from "./a.m4a" with { type: "file" }` gives the file's path (in a compiled binary, a /$bunfs one)
declare module "*.m4a" {
  const path: string
  export default path
}
