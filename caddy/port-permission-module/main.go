package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
)

var (
	minValue int
	maxValue int
)

func init() {
	var err error
	// Read environment variables for min and max values
	minValue, err = strconv.Atoi(getEnv("MIN_VALUE", "1"))
	if err != nil {
		log.Fatalf("Invalid MIN_VALUE: %v\n", err)
	}

	maxValue, err = strconv.Atoi(getEnv("MAX_VALUE", "100"))
	if err != nil {
		log.Fatalf("Invalid MAX_VALUE: %v\n", err)
	}

	log.Printf("Configured with MIN_VALUE=%d and MAX_VALUE=%d\n", minValue, maxValue)
}

// Helper function to get environment variables with a fallback default value
func getEnv(key, defaultValue string) string {
	value, exists := os.LookupEnv(key)
	if !exists {
		return defaultValue
	}
	return value
}

// Handler function to check the first subdomain
func checkSubdomainHandler(w http.ResponseWriter, r *http.Request) {
	domain := r.URL.Query().Get("domain")
	log.Printf("Received request with domain: %s\n", domain)

	if domain == "" {
		log.Println("Domain query parameter is required.")
		http.Error(w, "Domain query parameter is required.", http.StatusBadRequest)
		return
	}

	// Extract the first subdomain
	parts := strings.Split(domain, ".")
	if len(parts) < 2 {
		log.Println("Invalid domain format.")
		http.Error(w, "Invalid domain format.", http.StatusBadRequest)
		return
	}

	firstPart := parts[0]
	firstNumber, err := strconv.Atoi(firstPart)
	if err != nil {
		log.Printf("The first subdomain '%s' is not a number.\n", firstPart)
		http.Error(w, "The first subdomain is not a number.", http.StatusBadRequest)
		return
	}

	// Check if the number is within the specified range
	if firstNumber > minValue && firstNumber < maxValue {
		log.Printf("The number %d is within the range %d - %d. Returning 200 OK.\n", firstNumber, minValue, maxValue)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	} else {
		log.Printf("The number %d is not between %d and %d. Returning 400 Bad Request.\n", firstNumber, minValue, maxValue)
		http.Error(w, fmt.Sprintf("The number %d is not between %d and %d.", firstNumber, minValue, maxValue), http.StatusBadRequest)
	}
}

func main() {
	// Set server port from environment variable or default to 8000
	port := getEnv("PORT", "8000")
	log.Printf("Starting server on port %s...\n", port)

	http.HandleFunc("/check", checkSubdomainHandler)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatalf("Error starting server: %v\n", err)
	}
}
