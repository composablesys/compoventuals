#/usr/bin/sh

if [ -z "$3" ]
  then
    echo "Usage: ./micro_yjs.sh <out folder> <warmup trials> <recorded trials>"
    exit 1
fi

if [ $2 == "0" ] && [ $3 == "0" ]
then
    echo "test run"
    set -e
fi

for frequency in "whole" "rounds"
do
    for measurement in "time" "network" "memory"
    do
      for name in "Register" "LwwMap" "LwwMapRolling" "TextLtr" "TextRandom"
      do
          npm start -- $1 $2 $3 "micro_yjs" $name $measurement $frequency
      done
    done
done
