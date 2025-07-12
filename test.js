// Test file for Code Whisperer Voice extension
// Select this code and use the voice command to test the extension

function calculateFibonacci(n) {
    if (n <= 1) {
        return n;
    }
    return calculateFibonacci(n - 1) + calculateFibonacci(n - 2);
}

const result = calculateFibonacci(10);
console.log(`The 10th Fibonacci number is: ${result}`);

// This is a simple recursive function that calculates Fibonacci numbers
// It's a classic example used in programming tutorials 