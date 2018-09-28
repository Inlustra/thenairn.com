package main

import (
	"flag"
	"log"
	"net/http"
)

var rootDir string

func init() {
	flag.StringVar(&rootDir, "rootdir", "/data", "path to list files from")
	flag.Parse()
}

func main() {
	log.Fatal(http.ListenAndServe(":8080", http.FileServer(http.Dir(rootDir))))
}
