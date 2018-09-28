FROM golang:1.10
WORKDIR /go/src/app
COPY . .
RUN go install

FROM gcr.io/distroless/base
COPY --from=0 /go/bin/app .
ENTRYPOINT ["/app"]