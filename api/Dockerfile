# go.sum se genera en el build (`go mod tidy`) para no depender de un toolchain
# Go instalado en la máquina: el único requisito local del proyecto es Docker.
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN go mod tidy && CGO_ENABLED=0 go build -o /out/api .

FROM alpine:3.20
COPY --from=build /out/api /usr/local/bin/api
ENTRYPOINT ["/usr/local/bin/api"]
